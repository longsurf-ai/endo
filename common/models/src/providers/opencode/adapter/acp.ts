// Purpose: Owns one OpenCode ACP subprocess and its bounded JSON-RPC lifecycle.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import path from "node:path";

const Message = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

/** A native JSON-RPC rejection, preserving the method and machine-readable code. */
export class AcpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`OpenCode ${method} failed: ${message}`);
  }
}

export interface AcpOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Override only for deterministic fake-process tests. Production uses `acp`. */
  args?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  notification(method: string, params: unknown): void;
  request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Owns one native process. Requests time out by terminating the connection;
 * pending requests reject together, and native callbacks receive its abort signal.
 * Closing is idempotent and resolves only after process exit. Stderr is bounded.
 * @example
 * const acp = new AcpConnection(options);
 * try { await acp.request("initialize", {protocolVersion: 1, clientCapabilities: {}}); }
 * finally { await acp.close(); }
 */
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters = new Map<
    number,
    {
      method: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly lifetime = new AbortController();
  private readonly callbacks = new Set<Promise<void>>();
  private readonly exited: Promise<void>;
  private nextId = 0;
  private stderr = "";
  private failure?: Error;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: AcpOptions) {
    options.signal?.throwIfAborted();
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.cwd))
      throw new Error(
        "OpenCode requires absolute executable and working-directory paths",
      );
    this.child = spawn(options.executable, options.args ?? ["acp"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096);
    });
    this.exited = new Promise((resolve) => {
      const finish = (error: Error) => {
        this.fail(error);
        clearTimeout(this.killTimer);
        options.signal?.removeEventListener("abort", this.abort);
        resolve();
      };
      this.child.once("error", finish);
      this.child.once("close", (code, signal) =>
        finish(
          new Error(
            `OpenCode exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
          ),
        ),
      );
    });
    let frameBytes = 0;
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        frameBytes = byte === 10 ? 0 : frameBytes + 1;
        if (frameBytes > 16 * 1024 * 1024) {
          this.fail(new Error("OpenCode ACP message exceeds 16 MiB"));
          this.terminate();
          break;
        }
      }
    });
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      if (this.failure || !line.trim()) return;
      try {
        const message = Message.parse(JSON.parse(line));
        if (message.method !== undefined) {
          if (message.id === undefined)
            options.notification(message.method, message.params);
          else this.callback(message.id, message.method, message.params);
          return;
        }
        if (typeof message.id !== "number" || !this.waiters.has(message.id))
          throw new Error("OpenCode returned an unknown response ID");
        if ("result" in message === (message.error !== undefined))
          throw new Error("OpenCode returned an invalid response envelope");
        const waiter = this.waiters.get(message.id)!;
        this.waiters.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error)
          waiter.reject(
            new AcpError(
              waiter.method,
              message.error.code,
              message.error.message,
            ),
          );
        else waiter.resolve(message.result);
      } catch (cause) {
        this.fail(new Error("OpenCode sent an invalid ACP message", { cause }));
        this.terminate();
      }
    });
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  /** Sends a bounded native request; timeout terminates the entire uncertain connection. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`OpenCode ${method} timed out`));
        this.terminate();
      }, this.options.timeoutMs ?? 60_000);
      timer.unref();
      this.waiters.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Sends a notification while the connection is live. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends requests, aborts callbacks and awaits bounded native process termination. */
  async close(): Promise<void> {
    this.fail(new Error("OpenCode ACP connection is closed"));
    this.child.stdin.end();
    this.terminate();
    await this.exited;
    await Promise.allSettled([...this.callbacks]);
  }

  private readonly abort = () => {
    this.fail(
      new Error("OpenCode ACP connection was aborted", {
        cause: this.options.signal?.reason,
      }),
    );
    this.terminate();
  };

  private callback(id: string | number, method: string, params: unknown): void {
    const pending = Promise.resolve()
      .then(() => {
        this.lifetime.signal.throwIfAborted();
        return this.options.request(method, params, this.lifetime.signal);
      })
      .then(
        (result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
        () =>
          this.write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: "Endo declined the native request",
            },
          }),
      );
    this.callbacks.add(pending);
    void pending.finally(() => this.callbacks.delete(pending));
  }

  private write(message: object): void {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.lifetime.abort(this.failure);
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.waiters.clear();
  }

  private terminate(): void {
    if (
      this.killTimer ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    this.killTimer.unref();
  }
}
