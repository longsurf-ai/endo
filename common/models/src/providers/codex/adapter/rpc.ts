// Purpose: Runs one Codex app-server process and speaks newline-delimited JSON-RPC with it.
import { spawn as spawnProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ZodType } from "zod";
import { InitializeResponse } from "./protocol";

/** The process surface this layer needs; tests substitute in-memory streams. */
export interface ChildProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnCodex = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessLike;

export interface CodexRpcOptions {
  /** Absolute managed executable supplied by the host. */
  executable: string;
  env?: NodeJS.ProcessEnv;
  /** Per-request deadline. Thread starts wait on native MCP startup. */
  requestTimeoutMs?: number;
  spawn?: SpawnCodex;
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<unknown>;

export interface CodexRpc {
  /**
   * Sends a request, starting the process on first use, and parses the result.
   * Rejects on JSON-RPC errors, malformed results, timeouts and process exit.
   * @example const started = await rpc.request("thread/start", params, ThreadStartResponse);
   */
  request<T>(
    method: string,
    params: object | undefined,
    schema: ZodType<T>,
  ): Promise<T>;
  /** Receives every notification with its raw params; returns an unsubscribe. */
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  /** Installs the single answerer for server-to-client requests. Thrown errors become JSON-RPC errors. */
  setServerRequestHandler(handler: ServerRequestHandler): void;
  /** Observes unexpected process exit; every active request must fail. */
  onExit(listener: (error: Error) => void): () => void;
  /** Terminates the process; further requests reject. Idempotent. */
  close(): Promise<void>;
}

const defaultSpawn: SpawnCodex = (executable, args, env) =>
  spawnProcess(executable, args, { stdio: ["pipe", "pipe", "pipe"], env });

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

/**
 * One app-server process serves every session: all thread-scoped routing happens
 * above this layer. A crash rejects in-flight requests and notifies exit
 * listeners; the next request respawns. Nothing is replayed.
 * @example
 * const rpc = createCodexRpc({ executable });
 * try { await rpc.request("account/read", { refreshToken: false }, AccountReadResponse); }
 * finally { await rpc.close(); }
 */
export function createCodexRpc(options: CodexRpcOptions): CodexRpc {
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  const notificationListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  const exitListeners = new Set<(error: Error) => void>();
  const pending = new Map<number, Pending>();
  const incoming = new Map<unknown, AbortController>();
  let handler: ServerRequestHandler | undefined;
  let child: ChildProcessLike | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  let closed = false;

  function write(message: object): void {
    if (!child) throw new Error("codex app-server is not running");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function failAll(error: Error): void {
    for (const controller of incoming.values()) controller.abort(error);
    incoming.clear();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function send<T>(
    method: string,
    params: object | undefined,
    schema: ZodType<T>,
  ): Promise<T> {
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex request '${method}' timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        write({ id, method, ...(params ? { params } : {}) });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    }).then((result) => schema.parse(result));
  }

  async function answer(
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    const process_ = child;
    incoming.set(id, controller);
    try {
      if (!handler) throw new CodexRpcError(-32601, "Method not supported");
      const result = await handler(method, params, {
        signal: controller.signal,
      });
      if (child === process_ && !controller.signal.aborted)
        write({ id, result });
    } catch (error) {
      if (child !== process_ || controller.signal.aborted) return;
      const code = error instanceof CodexRpcError ? error.code : -32603;
      const message = error instanceof Error ? error.message : String(error);
      try {
        write({ id, error: { code, message } });
      } catch {
        // The process is gone; exit handling reports it.
      }
    } finally {
      if (incoming.get(id) === controller) incoming.delete(id);
    }
  }

  function handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Non-protocol output on stdout is ignored.
    }
    if (typeof message !== "object" || message === null) return;
    const { id, method, params, result, error } = message as Record<
      string,
      unknown
    >;
    const body =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        if (method === "serverRequest/resolved")
          incoming.get(body.requestId)?.abort();
        for (const listener of notificationListeners) listener(method, body);
      } else {
        void answer(id, method, body);
      }
      return;
    }
    if (typeof id !== "number") return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) {
      const failure = error as { code?: number; message?: string };
      entry.reject(
        new CodexRpcError(
          failure.code ?? -32000,
          failure.message ?? "Unknown JSON-RPC error",
        ),
      );
    } else entry.resolve(result);
  }

  function start(): Promise<void> {
    const process_ = (options.spawn ?? defaultSpawn)(
      options.executable,
      ["app-server", "--listen", "stdio://"],
      {
        ...process.env,
        ...options.env,
        RUST_LOG: process.env.RUST_LOG ?? "error",
      },
    );
    child = process_;
    let stderr = "";
    process_.stderr.on("data", (chunk: unknown) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2000);
    });
    createInterface({ input: process_.stdout, crlfDelay: Infinity }).on(
      "line",
      handleLine,
    );
    const gone = (summary: string) => {
      if (child !== process_) return;
      child = undefined;
      ready = undefined;
      const error = new Error(
        stderr.trim() ? `${summary}\n${stderr.trim()}` : summary,
      );
      failAll(error);
      if (!closed) for (const listener of exitListeners) listener(error);
    };
    process_.on("error", (error) =>
      gone(`codex app-server failed to start: ${error.message}`),
    );
    process_.on("exit", (code, signal) =>
      gone(
        closed
          ? "codex app-server closed"
          : `codex app-server exited (code=${String(code)}, signal=${String(signal)})`,
      ),
    );
    return send(
      "initialize",
      {
        clientInfo: { name: "openchart", version: "0" },
        capabilities: { experimentalApi: true },
      },
      InitializeResponse,
    ).then(() => write({ method: "initialized" }));
  }

  return {
    async request(method, params, schema) {
      if (closed) throw new Error("codex app-server is closed");
      ready ??= start().catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
      await ready;
      return send(method, params, schema);
    },
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    setServerRequestHandler(next) {
      handler = next;
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async close() {
      closed = true;
      const process_ = child;
      child = undefined;
      ready = undefined;
      failAll(new Error("codex app-server closed"));
      process_?.kill("SIGTERM");
    },
  };
}
