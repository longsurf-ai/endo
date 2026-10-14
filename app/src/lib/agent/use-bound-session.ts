// Purpose: Observe an existing bound Session without creating or executing one.
import { useQuery } from "@tanstack/react-query";

import type { AppTransport } from "@openchart/app/lib/transport/transport";

import { useAgentContext } from "./provider";
import { boundSessionQueryOptions } from "./queries";
import {
  activeRun,
  selectSessionProgress,
  sessionOutcome,
} from "./session-progress";
import { useSessionSnapshot } from "./use-session-snapshot";
import { workflowSessionStatus } from "./workflow-trace";

/**
 * Reads an opaque binding and observes its Session through the shared Agent.
 * Missing bindings have no progress; mounting never creates or submits a Session.
 * Active workflow progress comes from the parent's trace; terminal outcomes
 * also come from the child's durable message headers. `executionSessionId`
 * identifies the Session whose active Run can be cancelled. Query errors expose a retry.
 * The shared SessionStore reports observation failures through Sonner.
 * Unmount detaches this consumer without cancelling backend execution.
 * @example const session = useBoundSession(transport, `drawing:${drawingId}`);
 */
export function useBoundSession(transport: AppTransport, bindingKey: string) {
  const { agent } = useAgentContext();
  const bound = useQuery(boundSessionQueryOptions(transport, bindingKey));
  const id = bound.data?.id;
  const parentId = bound.data?.parentId ?? undefined;
  const snapshot = useSessionSnapshot(agent, id, (value) => value);
  const parent = useSessionSnapshot(agent, parentId, (value) => value);
  const span = id ? workflowSessionStatus(parent, id) : undefined;
  const ownRun = activeRun(snapshot.state);
  const run =
    ownRun ?? (span === "running" ? activeRun(parent.state) : undefined);
  const execution = run ? "running" : (sessionOutcome(snapshot) ?? span);
  return {
    session: bound.data,
    snapshot,
    execution,
    executionSessionId: run ? (ownRun ? id : parentId) : undefined,
    loading: bound.isPending || snapshot.loading,
    progress: selectSessionProgress(snapshot, run),
    error: bound.error ?? (snapshot.error ? new Error(snapshot.error) : null),
    retry: bound.error
      ? () => {
          void bound.refetch();
        }
      : undefined,
  };
}
