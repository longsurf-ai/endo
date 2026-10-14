// Purpose: Routes one process's thread-scoped notifications and server requests to the owning request.
import { parseServerRequest, type ServerRequest } from "./protocol";
import { CodexRpcError, type CodexRpc } from "./rpc";

/** Everything one request needs to receive from its root thread and native descendants. */
export interface ThreadContext {
  notification(method: string, params: Record<string, unknown>): void;
  /** Answers an approval or tool request; the router applies fail-closed defaults for unknown threads. */
  request(
    request: ServerRequest,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}

/**
 * Fail-closed answers: nothing runs, nothing is approved, no input is invented.
 * Unknown methods reject with the JSON-RPC method-not-found code.
 * @example return declineServerRequest(request.method);
 */
export function declineServerRequest(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null };
    case "item/tool/call":
      return { contentItems: [], success: false };
    case "item/tool/requestUserInput":
      return { answers: {} };
    default:
      throw new CodexRpcError(-32601, "Method not supported");
  }
}

function threadIdOf(params: Record<string, unknown>): string | undefined {
  if (typeof params.threadId === "string") return params.threadId;
  const thread = params.thread;
  return typeof thread === "object" &&
    thread !== null &&
    typeof (thread as { id?: unknown }).id === "string"
    ? (thread as { id: string }).id
    : undefined;
}

/**
 * Session routing over one shared process. A request registers its root thread;
 * native subagent threads join the same context through `thread/started`
 * (`parentThreadId`) or through the request adopting them when native items
 * announce them, so child approvals and tool calls reach the owning session.
 * Events for unregistered threads are dropped and their requests declined.
 * Concurrent requests never share a context.
 * @example
 * const router = createThreadRouter(rpc);
 * const registration = router.register(threadId, context);
 * registration.adopt(childThreadId);
 * registration.release();
 */
export function createThreadRouter(rpc: CodexRpc) {
  const contexts = new Map<string, ThreadContext>();
  rpc.onNotification((method, params) => {
    if (method === "thread/started") {
      const thread = params.thread as
        { id?: unknown; parentThreadId?: unknown } | undefined;
      const parent =
        typeof thread?.parentThreadId === "string"
          ? contexts.get(thread.parentThreadId)
          : undefined;
      if (parent && typeof thread?.id === "string")
        contexts.set(thread.id, parent);
    }
    const threadId = threadIdOf(params);
    if (threadId) contexts.get(threadId)?.notification(method, params);
  });
  rpc.setServerRequestHandler(async (method, params, options) => {
    const request = parseServerRequest(method, params);
    if (!request) throw new CodexRpcError(-32601, "Method not supported");
    const context = contexts.get(request.params.threadId);
    return context
      ? await context.request(request, options)
      : declineServerRequest(method);
  });
  return {
    register(threadId: string, context: ThreadContext) {
      contexts.set(threadId, context);
      return {
        /** Routes a native descendant thread to this request. */
        adopt(childThreadId: string): void {
          if (!contexts.has(childThreadId))
            contexts.set(childThreadId, context);
        },
        release(): void {
          for (const [id, owner] of contexts)
            if (owner === context) contexts.delete(id);
        },
      };
    },
  };
}

export type ThreadRouter = ReturnType<typeof createThreadRouter>;
