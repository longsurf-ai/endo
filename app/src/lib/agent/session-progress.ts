// Purpose: Derive consumer-independent progress from the shared Session snapshot.
import type { SessionSnapshot } from "@openchart/app/lib/agent/session-store";

/** Active Run progress with epoch-millisecond time and untruncated current-turn lines. */
export type SessionProgress = {
  status: "queued" | "running";
  startedAt: number;
  lines: string[];
};

type Run = NonNullable<SessionSnapshot["state"]>["runs"][number];

/** The running Run, else the first queued one; terminal or unobserved state has none. @example activeRun(snapshot.state) */
export function activeRun(state: SessionSnapshot["state"]): Run | undefined {
  return (
    state?.runs.find((run) => run.status === "running") ??
    state?.runs.find((run) => run.status === "queued")
  );
}

/** Reads the latest Assistant's durable completion, independent of its parent's paginated trace. @example sessionOutcome(snapshot) === "cancelled" */
export function sessionOutcome(snapshot: SessionSnapshot) {
  for (let index = snapshot.messages.length - 1; index >= 0; index--) {
    const message = snapshot.messages[index]!;
    if (message.role !== "assistant" || message.subagentRunId !== undefined)
      continue;
    const id = message.metadata?.openchart?.messageId ?? message.id;
    const info = snapshot.state?.messageInfo[id];
    if (!info || !("completedAt" in info)) continue;
    if (info.error)
      return info.error.name === "MessageAbortedError" ? "cancelled" : "failed";
    if (info.completedAt !== null && info.finish !== "tool-calls")
      return "completed";
    return undefined;
  }
  return undefined;
}

/**
 * Derives active Run progress from a Session snapshot without mutating it.
 * Unobserved state and terminal Runs return undefined. A workflow child owns
 * no Run; its caller passes the parent's active Run while the child's span runs.
 * Consumers own subscriptions, line limits and display clocks.
 * @example const progress = selectSessionProgress(snapshot);
 */
export function selectSessionProgress(
  snapshot: SessionSnapshot,
  run = activeRun(snapshot.state),
): SessionProgress | undefined {
  if (!run) return undefined;
  const latestUser = snapshot.messages
    .map((message) => message.role)
    .lastIndexOf("user");
  const lines = snapshot.messages.slice(latestUser + 1).flatMap((message) => {
    if (message.role !== "assistant" && message.role !== "reasoning") return [];
    if (message.metadata?.openchart?.createdAt < run.createdAt) return [];
    const text = typeof message.content === "string" ? message.content : "";
    const tools =
      message.role === "assistant"
        ? (message.toolCalls?.map((call) => `Using ${call.function.name}…`) ??
          [])
        : [];
    return [
      ...text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      ...tools,
    ];
  });
  return {
    status: run.status === "queued" ? "queued" : "running",
    startedAt: run.startedAt ?? run.createdAt,
    lines,
  };
}
