// Purpose: Owns one `grok agent stdio` process and its ACP JSON-RPC traffic.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { RpcMessage } from "./events";

const STDERR_LIMIT = 4096;
/** An agent that ignores SIGTERM is killed after this grace period. */
const KILL_AFTER_MS = 5_000;

/** A JSON-RPC error the agent returned for one request. */
export class AcpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(
      `Grok ${method} failed: ${message}${data ? ` (${String(data)})` : ""}`,
    );
  }
}

export interface AcpHandlers {
  /** Agent notifications such as `session/update`; called in arrival order. */
  notification(method: string, params: unknown): void;
  /**
   * Agent-to-client requests such as `session/request_permission`. Resolves
   * with the result; rejecting answers with a JSON-RPC error.
   */
  request(method: string, params: unknown): Promise<unknown>;
}

export interface AcpConnectionOptions {
  executable: string;
  cwd?: string;
  env: Record<string, string>;
  handlers: AcpHandlers;
}

/**
 * One agent process per connection. Requests resolve with their result or
 * reject with {@link AcpError}; every pending request rejects once the
 * process exits, carrying the tail of its stderr. Unparseable stdout ends the
 * connection rather than guessing.
 * @example
 * const acp = new AcpConnection({ executable, env, handlers });
 * try { await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); }
 * finally { acp.close(); }
 */
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private nextId = 0;
  private stderr = "";
  private failure: Error | undefined;
  /** Settles once the process has exited. */
  readonly exited: Promise<void>;

  constructor(options: AcpConnectionOptions) {
    // `--no-leader` keeps every call in its own agent even when the user
    // enabled Grok's shared leader process.
    this.child = spawn(options.executable, ["agent", "--no-leader", "stdio"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    this.exited = new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.fail(error);
        resolve();
      });
      this.child.on("close", (code, signal) => {
        const detail = this.stderr.trim();
        this.fail(
          new Error(
            `Grok exited (${signal ?? code})${detail ? `: ${detail}` : ""}`,
          ),
        );
        resolve();
      });
    });
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      if (!line.trim() || this.failure) return;
      let message: RpcMessage;
      try {
        message = RpcMessage.parse(JSON.parse(line));
      } catch (cause) {
        this.fail(new Error("Grok sent an invalid ACP message", { cause }));
        this.kill();
        return;
      }
      this.receive(message, options.handlers);
    });
  }

  /** Sends one request; it settles with the response or when the process exits. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.failure) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends stdin, then terminates the agent; idempotent. */
  close(): void {
    this.child.stdin.end();
    this.kill();
  }

  private kill(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGKILL");
    }, KILL_AFTER_MS).unref();
  }

  private write(message: object): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(this.failure);
    }
  }

  private receive(message: RpcMessage, handlers: AcpHandlers): void {
    if (message.method === undefined) {
      if (typeof message.id !== "number") return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error)
        waiter.reject(
          new AcpError(
            waiter.method,
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
      else waiter.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      handlers.notification(message.method, message.params);
      return;
    }
    const { id, method } = message;
    Promise.resolve()
      .then(() => handlers.request(method, message.params))
      .then(
        (result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) =>
          this.write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
  }
}
