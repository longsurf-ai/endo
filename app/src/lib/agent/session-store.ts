import { toast } from "sonner";
// Purpose: Shares AG-UI-owned session state across independently subscribed consumers.

import { InfiniteQueryObserver, type QueryClient } from "@tanstack/react-query";
import { transcriptQueryOptions } from "./queries";
import { mergeTranscript } from "./transcript";
import { AbstractAgent } from "@ag-ui/client";
import type {
  AGUIEvent,
  BaseEvent,
  Message,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  SubagentErrorEvent,
} from "@ag-ui/core";
import { type Observable, type Subscription, throwError } from "rxjs";

import type {
  ModelSelection,
  PermissionReply,
  QuestionReply,
  AgentClient,
  SessionState,
} from "@openchart/app/lib/agent/client";
import type { PromptParts } from "@openchart/app/lib/prompt-converter/converter";

class ObservingAgent extends AbstractAgent {
  /**
   * Execution commands go through admission; this agent only observes commits.
   * @example
   * await session.submit([{ type: 'text', text: 'Explain this chart' }], model);
   */
  override run(): Observable<BaseEvent> {
    return throwError(() => new Error("Submit prompts through the session."));
  }

  /**
   * Uses the SDK's reducer extension points for a persistent session stream.
   * Unlike one run, this stream can begin idle and span multiple durable runs.
   * @example
   * agent.observe(remote.observe(sessionID)).subscribe();
   */
  observe(events: Observable<AGUIEvent>) {
    const input = this.prepareRunAgentInput();
    return this.processApplyEvents(
      input,
      this.apply(input, events, this.subscribers),
      this.subscribers,
    );
  }
}

/** Native invocation events retained for display; AG-UI still reduces all content. */
export type Subagent = {
  start: SubagentStartedEvent;
  end?: SubagentFinishedEvent | SubagentErrorEvent;
};

/** Current snapshot of one backend session. Messages and state belong to AG-UI. */
export type SessionSnapshot = {
  messages: Message[];
  subagents: Readonly<Record<string, Subagent>>;
  state: SessionState | undefined;
  loading: boolean;
  /** Latest execution failure; command rejections and transport failures are reported separately. */
  error: string | undefined;
  /** Older-page request state, shared across every view of this Session. */
  history: { hasMore: boolean; loading: boolean; error: string | undefined };
};

/**
 * Shares one observer per session ID while it has listeners. The last
 * unsubscribe detaches observation, never backend execution. Reopening gets a
 * fresh backend snapshot while retaining the cached handle identity.
 * There is no transcript reducer, run state machine, or replay buffer here.
 *
 * @example
 * const store = createSessionStore(createAgentClient(transport), queryClient);
 * const session = store.getSession(sessionID);
 * const unsubscribe = session.subscribe(() => console.log(session.getSnapshot()));
 * unsubscribe();
 * store.dispose();
 */
export function createSessionStore(
  remote: Pick<
    AgentClient,
    | "observe"
    | "prompt"
    | "renameSession"
    | "cancel"
    | "replyPermission"
    | "replyQuestion"
    | "readTranscriptPage"
  > & { transport: { url: string } },
  queryClient: QueryClient,
) {
  const sessions = new Map<string, ReturnType<typeof createSessionHandle>>();
  function createSessionHandle(id: string) {
    const agent = new ObservingAgent({ threadId: id });
    const listeners = new Set<() => void>();
    let observation: Subscription | undefined;
    let live: SessionSnapshot = {
      messages: agent.messages,
      subagents: {},
      state: undefined,
      loading: true,
      error: undefined,
      history: { hasMore: false, loading: false, error: undefined },
    };
    let current = live;
    let stopHistory: (() => void) | undefined;
    const historyOptions = () =>
      transcriptQueryOptions(
        remote,
        id,
        live.state?.history.nextCursor ?? undefined,
      );
    const history = new InfiniteQueryObserver(queryClient, historyOptions());
    const resetHistory = () => {
      queryClient.removeQueries({
        queryKey: historyOptions().queryKey,
        exact: true,
      });
      // Release the observer's old result as well as the Query cache.
      history.setOptions(historyOptions());
    };
    const publish = () => {
      const result = history.getCurrentResult();
      live = {
        ...live,
        messages: agent.messages,
        history: {
          // Before any page loads, the snapshot's cursor decides; afterwards the
          // last page's null cursor means the beginning.
          hasMore:
            !live.loading &&
            (result.data
              ? result.hasNextPage
              : live.state?.history.nextCursor != null),
          loading: result.isFetching,
          error: result.error?.message,
        },
      };
      current = mergeTranscript(live, result.data?.pages ?? []);
      for (const listener of listeners) listener();
    };
    agent.subscribe({
      // Snapshots authoritatively replace the latest complete-turn window. The SDK's default merge
      // retains cached order and omitted Activity, which is wrong after a gap.
      onMessagesSnapshotEvent: ({ event }) => {
        // Keep invocation identity across ordinary transcript snapshots. Session
        // snapshots reannounce every invocation, replacing its native lifecycle records.
        const ids = new Set(event.messages.map((message) => message.id));
        live = {
          ...live,
          subagents: Object.fromEntries(
            Object.entries(live.subagents).filter(
              ([, child]) =>
                child.start.parentMessageId !== undefined &&
                ids.has(child.start.parentMessageId),
            ),
          ),
        };
        live = { ...live, loading: true };
        // Removing the query cancels obsolete requests even when the new cursor
        // is unchanged (reconnect, edits, truncation). No second page cache.
        resetHistory();
        return {
          messages: structuredClone(event.messages),
          stopPropagation: true,
        };
      },
      onSubagentStartedEvent: ({ event }) => {
        live = {
          ...live,
          subagents: {
            ...live.subagents,
            [event.subagentRunId]: { start: event },
          },
        };
        publish();
      },
      onSubagentFinishedEvent: ({ event }) => finishSubagent(event),
      onSubagentErrorEvent: ({ event }) => finishSubagent(event),
      onMessagesChanged: publish,
      onRunStartedEvent: () => {
        live = { ...live, error: undefined };
        publish();
      },
      onStateChanged: ({ state }) => {
        live = {
          ...live,
          state: state as SessionState,
          loading: false,
        };
        history.setOptions(historyOptions());
        publish();
      },
      onRunErrorEvent: ({ event }) => {
        live = { ...live, error: event.message };
        publish();
      },
    });

    function finishSubagent(event: SubagentFinishedEvent | SubagentErrorEvent) {
      const subagent = live.subagents[event.subagentRunId];
      if (!subagent)
        throw new Error("Subagent completion requires its start event");
      live = {
        ...live,
        subagents: {
          ...live.subagents,
          [event.subagentRunId]: { ...subagent, end: event },
        },
      };
      publish();
    }

    return {
      id,
      getSnapshot: () => current,
      /** Fetches older complete turns; Query owns cancellation, retries and errors. @example await session.loadOlder(); */
      loadOlder: async () => {
        if (!current.history.hasMore || history.getCurrentResult().isFetching)
          return;
        await history.fetchNextPage();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        stopHistory ??= history.subscribe(publish);
        observation ??= agent.observe(remote.observe(id)).subscribe({
          error: (error: unknown) => {
            live = { ...live, loading: false };
            toast.error("Conversation connection interrupted", {
              id: `session:${id}`,
              description:
                error instanceof Error ? error.message : String(error),
            });
            publish();
          },
        });
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            observation?.unsubscribe();
            observation = undefined;
            stopHistory?.();
            stopHistory = undefined;
            resetHistory();
            live = { ...live, loading: true };
            publish();
          }
        };
      },
      submit: (
        parts: PromptParts,
        model: ModelSelection,
        workspaceId?: string,
      ) =>
        remote.prompt({
          sessionID: id,
          sessionIntentID: crypto.randomUUID(),
          input: {
            agent: "analyst",
            model,
            parts,
            ...(workspaceId ? { workspaceId } : {}),
          },
        }),
      /**
       * Renames through Session persistence; committed events update observers.
       * @example await session.rename('Market research');
       */
      rename: (title: string) => remote.renameSession({ sessionID: id, title }),
      cancel: () => remote.cancel(id),
      replyQuestion: (requestID: string, reply: QuestionReply) =>
        remote.replyQuestion(requestID, reply),
      replyPermission: (requestID: string, reply: PermissionReply) =>
        remote.replyPermission(requestID, reply),
      dispose: () => {
        observation?.unsubscribe();
        observation = undefined;
        stopHistory?.();
        stopHistory = undefined;
        resetHistory();
        live = { ...live, loading: true };
        listeners.clear();
        publish();
      },
    };
  }

  return {
    /**
     * Gets the shared handle without creating a backend Session or observing it.
     * Observation starts on subscribe; the last unsubscribe detaches it without
     * cancelling execution. Commands reject on failure; snapshot.error holds execution failures.
     * @example const session = store.getSession(sessionID);
     */
    getSession(id: string) {
      let session = sessions.get(id);
      if (!session) {
        session = createSessionHandle(id);
        sessions.set(id, session);
      }
      return session;
    },
    dispose() {
      // Retain handle identity when React reactivates effects in Strict Mode.
      for (const session of sessions.values()) session.dispose();
    },
  };
}

/** Shared identity and subscription surface used by custom UI and assistant-ui. */
export type SessionStore = ReturnType<typeof createSessionStore>;
