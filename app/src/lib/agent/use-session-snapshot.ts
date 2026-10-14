// Purpose: Gives custom React UI fine-grained subscriptions to the shared AG-UI session.

import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";

import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";

const emptySnapshot: SessionSnapshot = {
  messages: [],
  subagents: {},
  state: undefined,
  loading: false,
  error: undefined,
  history: { hasMore: false, loading: false, error: undefined },
};
const getEmptySnapshot = () => emptySnapshot;
const subscribeToNothing = () => () => {};

/**
 * Selects reactive state for any session ID, independent of the visible chat.
 * Call this hook for each desired session; all consumers share its AG-UI agent.
 * An absent ID returns an empty snapshot without creating or observing a Session.
 *
 * @example
 * const messages = useSessionSnapshot(agent, sessionID, snapshot => snapshot.messages);
 * const otherMessages = useSessionSnapshot(agent, childSessionID, snapshot => snapshot.messages);
 */
export function useSessionSnapshot<T>(
  agent: Pick<SessionStore, "getSession">,
  sessionID: string | undefined,
  selector: (snapshot: SessionSnapshot) => T,
) {
  const session = sessionID ? agent.getSession(sessionID) : undefined;
  return useSyncExternalStoreWithSelector(
    session?.subscribe ?? subscribeToNothing,
    session?.getSnapshot ?? getEmptySnapshot,
    session?.getSnapshot ?? getEmptySnapshot,
    selector,
    Object.is,
  );
}

/**
 * Select the latest top-level user turn's info, which carries the model and workspace the
 * Session last used. Subagent turns are skipped; an unloaded or empty Session gives undefined.
 * @example const last = useSessionSnapshot(agent, sessionID, lastUserInfo);
 */
export function lastUserInfo(snapshot: SessionSnapshot) {
  for (let index = snapshot.messages.length - 1; index >= 0; index--) {
    const message = snapshot.messages[index]!;
    if (message.role === "user" && message.subagentRunId === undefined)
      return snapshot.state?.messageInfo[message.id];
  }
  return undefined;
}
