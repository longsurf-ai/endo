// Purpose: Projects durable delegate links into native AG-UI attribution and lifecycle.

import {
  EventType,
  type AGUIEvent,
  type SubagentStartedEvent,
} from "@ag-ui/core";
import type { WithParts } from "@openchart/server/agent/contracts/message";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import {
  SessionId,
  type Session as SessionInfo,
} from "@openchart/server/agent/contracts/session";
import { Session } from "@openchart/server/agent/session";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Effect } from "effect";
import { activePartEvents, projectTranscript } from "./projection";
import { projectMessageInfo } from "./state";
import { toolDelegateSessionId } from "./tool-delegate";

type Transcript = {
  session: SessionInfo;
  history: readonly WithParts[];
};

/**
 * One observer's projected Session and linked delegates, ready for bootstrap.
 * Install content and state before restoring lifecycle and unfinished streams.
 *
 * ```text
 * Example: child invocation C is still streaming text Part P for Assistant A.
 *
 * Field          Bootstrap delivery               Client learns
 * messages    -> MESSAGES_SNAPSHOT                 P="Hello", subagentRunId=C
 * messageInfo -> STATE_SNAPSHOT.messageInfo        A={completedAt:null, ...}
 * lifecycle   -> SUBAGENT_STARTED(C)               C's name and parent link
 * open        -> TEXT_MESSAGE_START(P)             reopen P under C
 *
 * Next live TEXT_MESSAGE_CONTENT(P, " world") -> P says "Hello world".
 * The snapshot supplies existing content; open never repeats its deltas.
 * ```
 */
type TreeProjection = {
  /**
   * Visible root history plus descendant Assistant output, attributed by
   * invocation. Descendant user inputs stay private to their own Session.
   */
  messages: ReturnType<typeof projectTranscript>;

  /** Own User model choices and visible Assistant completion facts, keyed by Message ID. */
  messageInfo: ReturnType<typeof projectMessageInfo>;
  /**
   * Subagent lifecycle: START(parent) -> child lifecycles -> parent's
   * FINISHED/ERROR, if completed. An unfinished invocation has only its START.
   */
  lifecycle: AGUIEvent[];
  /**
   * Starts for unfinished text/reasoning and pending tool arguments.
   * Restores stream bookkeeping while preserving the snapshot's content.
   */
  open: AGUIEvent[];
};

function links(history: readonly WithParts[]) {
  return history.flatMap(({ parts }) =>
    parts.filter(
      (part): part is ToolPart =>
        part.type === "tool" && toolDelegateSessionId(part) !== undefined,
    ),
  );
}

/**
 * Reads the linked delegate tree through Session, reusing an already loaded root.
 * Supply a root only while holding the same publication barrier. Every node is
 * one latest page: a page includes only delegates linked from it, and each
 * delegate contributes its own latest page. task creates a fresh delegate per
 * call, so that page is normally its whole transcript.
 * @example
 * yield* readTree(yield* sessions.readTranscriptPage({sessionID}));
 */
export const readTree = Effect.fn("AGUI.readTree")(function* (
  root: Transcript,
) {
  const sessions = yield* Session.Service;
  const transcripts = new Map<string, Transcript>();
  const pending: Transcript[] = [root];
  while (pending.length > 0) {
    const transcript = pending.shift()!;
    const id = transcript.session.id;
    assertTrue(!transcripts.has(id), "Delegate links must form a tree");
    transcripts.set(id, transcript);
    for (const part of links(transcript.history)) {
      pending.push(
        yield* sessions
          .readTranscriptPage({ sessionID: toolDelegateSessionId(part)! })
          .pipe(Effect.orDie),
      );
    }
  }
  return transcripts;
});

/** One invocation uses its durable proxy Part ID, never a reusable agent name. @example subagentStart(proxy, child.title); */
export function subagentStart(
  part: ToolPart,
  name: string,
  parentSubagentRunId?: string,
): SubagentStartedEvent {
  return {
    type: EventType.SUBAGENT_STARTED,
    subagentRunId: part.id,
    name,
    parentToolCallId: part.callID,
    parentMessageId: part.id,
    ...(parentSubagentRunId === undefined ? {} : { parentSubagentRunId }),
  };
}

/** The proxy settles after the entire child invocation, including cleanup. @example subagentEnd(proxy); */
export function subagentEnd(part: ToolPart): AGUIEvent[] {
  if (
    toolDelegateSessionId(part) === undefined ||
    (part.state.status !== "completed" && part.state.status !== "error")
  )
    return [];
  return [
    part.state.status === "error"
      ? {
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: part.id,
          message: part.state.error,
        }
      : { type: EventType.SUBAGENT_FINISHED, subagentRunId: part.id },
  ];
}

/** Tags attributable native events; run boundaries stay with their own Session. @example attribute(event, proxy.id); */
export function attribute(event: AGUIEvent, subagentRunId: string): AGUIEvent {
  switch (event.type) {
    case EventType.SUBAGENT_STARTED:
      return { ...event, parentSubagentRunId: subagentRunId };
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_ERROR:
      return event;
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
      throw new Error(
        "Session snapshots and Run boundaries cannot be attributed",
      );
    default:
      return { ...event, subagentRunId };
  }
}

/** Resolves ancestor observers from committed proxy links, without a routing cache. @example yield* ancestors(childID); */
export const ancestors = Effect.fn("AGUI.ancestors")(function* (
  sessionID: string,
) {
  const sessions = yield* Session.Service;
  let session = yield* sessions
    .get(SessionId.make(sessionID))
    .pipe(Effect.orDie);
  const result: { sessionID: string; proxy: ToolPart }[] = [];
  const seen = new Set([sessionID]);
  while (session?.kind === "delegate" && session.parentId !== null) {
    assertTrue(
      !seen.has(session.parentId),
      "Delegate ancestry must be acyclic",
    );
    seen.add(session.parentId);
    // A delegate publishes only while its parent's turn is open, so its proxy
    // link is on the parent's latest page.
    const parent = yield* sessions
      .readTranscriptPage({ sessionID: session.parentId })
      .pipe(Effect.orDie);
    const proxy = links(parent.history).find(
      (part) => toolDelegateSessionId(part) === session!.id,
    );
    // Child creation commits before its parent's proxy link. Its initial input
    // belongs only to the child; publication begins once that link commits.
    if (!proxy) break;
    result.push({ sessionID: parent.session.id, proxy });
    session = parent.session;
  }
  return result;
});

/**
 * Builds the same attributed history and lifecycle used on live delivery.
 * The observed root keeps its inputs; descendants contribute only Assistant
 * output. Projections preserve proxy link order without changing the input tree.
 * @throws If the root or a linked delegate transcript is missing.
 * @example
 * const projection = projectTree(page.session.id, yield* readTree(page));
 */
export function projectTree(
  rootID: string,
  tree: ReadonlyMap<string, Transcript>,
) {
  function visit(
    transcript: Transcript,
    invocation?: SubagentStartedEvent,
    proxy?: ToolPart,
  ): TreeProjection {
    const history =
      invocation === undefined
        ? transcript.history
        : transcript.history.filter(({ info }) => info.role === "assistant");
    const messages = projectTranscript(history).map((message) =>
      invocation === undefined
        ? message
        : { ...message, subagentRunId: invocation.subagentRunId },
    );
    const messageInfo = projectMessageInfo(history);
    const open = activePartEvents(history).map((event) =>
      invocation === undefined
        ? event
        : attribute(event, invocation.subagentRunId),
    );
    const children = links(history).map((proxy) => {
      const childTranscript = tree.get(toolDelegateSessionId(proxy)!);
      assertExists(childTranscript, "Delegate transcript must be loaded");
      return visit(
        childTranscript,
        subagentStart(
          proxy,
          childTranscript.session.title,
          invocation?.subagentRunId,
        ),
        proxy,
      );
    });
    const end = proxy === undefined ? [] : subagentEnd(proxy);

    return {
      messages: [...messages, ...children.flatMap((child) => child.messages)],
      messageInfo: Object.fromEntries([
        ...Object.entries(messageInfo),
        ...children.flatMap((child) => Object.entries(child.messageInfo)),
      ]),
      // A parent's start precedes every child lifecycle; its end follows them.
      lifecycle: [
        ...(invocation === undefined ? [] : [invocation]),
        ...children.flatMap((child) => child.lifecycle),
        ...end,
      ],
      open: [...open, ...children.flatMap((child) => child.open)],
    };
  }

  const root = tree.get(rootID);
  assertExists(root, "Delegate transcript must be loaded");
  return visit(root);
}
