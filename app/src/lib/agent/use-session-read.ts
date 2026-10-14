// Purpose: Acknowledge displayed results through the existing Session command.
import { useEffect } from "react";
import type { SessionSnapshot } from "./session-store";
import type { Agent } from "./use-agent";

/** Mark the displayed ended Run read only in a visible, focused conversation. Hidden views and absent/loading snapshots never acknowledge results; displayed execution failures are readable results too. @example useSessionRead(agent.markSessionRead.mutate, snapshot, visible); */
export function useSessionRead(
  markRead: Agent["markSessionRead"]["mutate"],
  snapshot: SessionSnapshot,
  visible: boolean,
) {
  const latest = snapshot.state?.runs.at(-1);
  const runId =
    !snapshot.loading && latest?.finishedAt != null ? latest.id : undefined;
  const lastReadRunId = snapshot.state?.session.lastReadRunId;
  useEffect(() => {
    if (!visible || !runId || (lastReadRunId != null && lastReadRunId >= runId))
      return;
    const read = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus())
        return;
      markRead({ runId });
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [visible, runId, lastReadRunId, markRead]);
}
