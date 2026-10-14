// Purpose: Adapts authoritative Agent changes and snapshots to live AG-UI delivery.

import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { Part } from "@openchart/server/agent/contracts/part";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Session } from "@openchart/server/agent/session";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Effect, Layer } from "effect";
import { isDeepStrictEqual } from "node:util";
import { messageInfoEvent, messageInfoState } from "./state";
import { readHistoryPage } from "./history";
import { toolDelegateSessionId } from "./tool-delegate";
import {
  AgentSnapshot,
  AgentEvent,
  SessionListBootstrap,
  runEvents,
  stateEvent,
} from "./events";
import {
  partCompletionEvents,
  partEvents,
  userMessageEvents,
} from "./projection";
import {
  ancestors,
  attribute,
  projectTree,
  readTree,
  subagentEnd,
  subagentStart,
} from "./subagents";

// Every recipient gets its own payload; delivery preserves the batch's order.
const publish = Effect.fn("AGUI.publish")(function* (
  deliveries: readonly (typeof AgentEvent.Type)["data"][],
) {
  const events = yield* Events.Service;
  yield* Effect.forEach(
    deliveries,
    (data) => events.publish(AgentEvent, structuredClone(data)),
    { discard: true, concurrency: 1 },
  );
});

function publishSession(sessionID: string, native: readonly AGUIEvent[]) {
  return publish(native.map((event) => ({ sessionID, event })));
}

const publishTranscript = Effect.fn("AGUI.publishTranscript")(function* (
  sessionID: string,
  native: readonly AGUIEvent[],
) {
  if (native.length === 0) return;
  const parents = yield* ancestors(sessionID);
  yield* publish(
    native.flatMap((event) => [
      { sessionID, event },
      ...parents.map((parent) => ({
        sessionID: parent.sessionID,
        event: attribute(event, parents[0]!.proxy.id),
      })),
    ]),
  );
});

const publishSnapshots = Effect.fn("AGUI.publishSnapshots")(function* (
  sessionID: string,
) {
  const observers = [
    sessionID,
    ...(yield* ancestors(sessionID)).map((parent) => parent.sessionID),
  ];
  for (const observerID of observers) {
    const projected = yield* readHistoryPage({ sessionID: observerID }).pipe(
      Effect.orDie,
    );
    yield* publishSession(observerID, [
      { type: EventType.MESSAGES_SNAPSHOT, messages: projected.messages },
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "add", path: "/messageInfo", value: projected.messageInfo },
          {
            op: "add",
            path: "/history",
            value: { nextCursor: projected.nextCursor },
          },
        ],
      },
    ]);
  }
});

function isTerminalToolPart(part: Part | undefined) {
  return (
    part?.type === "tool" &&
    (part.state.status === "completed" || part.state.status === "error")
  );
}

// The caller holds the publication barrier until all events and required
// snapshot reads finish. Reading later could mix this change with a newer write.
const publishChange = Effect.fn("AGUI.publishChange")(function* (
  change: Publisher.Change,
) {
  switch (change.type) {
    case "transcript.updated":
      return yield* publishSnapshots(change.sessionID);
    case "session.updated":
      return yield* publishSession(change.session.id, [
        stateEvent("session", change.session),
      ]);
    case "questions.updated":
      return yield* publishSession(change.sessionID, [
        stateEvent("questions", change.questions),
      ]);
    case "permissions.updated":
      return yield* publishSession(change.sessionID, [
        stateEvent("permissions", change.permissions),
      ]);
    case "run.updated":
      return yield* publishSession(change.run.sessionID, runEvents(change));
    case "message.created": {
      const { info, parts } = change.message;
      // A complete user input appends with the history projection, only to its
      // own Session: delegate input stays private and older pages remain valid.
      if (info.role === "user")
        return yield* publishSession(info.sessionID, [
          ...messageInfoEvent(info),
          ...userMessageEvents(change.message),
        ]);
      const native = messageInfoEvent(info);
      for (const part of parts) {
        const projected = partEvents(info, undefined, part);
        if (projected === undefined) {
          yield* publishTranscript(info.sessionID, native);
          return yield* publishSnapshots(info.sessionID);
        }
        native.push(...projected);
      }
      return yield* publishTranscript(info.sessionID, native);
    }
    case "message.updated":
      if (
        isDeepStrictEqual(
          messageInfoState(change.previous),
          messageInfoState(change.message),
        )
      )
        return;
      if (change.message.role === "user")
        return yield* publishSession(
          change.message.sessionID,
          messageInfoEvent(change.message),
        );
      yield* publishTranscript(
        change.message.sessionID,
        messageInfoEvent(change.message),
      );
      return;
    case "step.finished":
      yield* publishTranscript(change.message.sessionID, [
        {
          type: EventType.STEP_FINISHED,
          stepName: change.message.id,
          metadata: { usage: change.part.tokens, cost: change.part.cost },
        },
        ...messageInfoEvent(change.message),
      ]);
      return;
    case "part.updated": {
      const { info, previous, part } = change;
      const childSessionId =
        part.type === "tool" ? toolDelegateSessionId(part) : undefined;
      // Close the delegate before its enclosing tool result: TC < start < end < TR.
      if (part.type === "tool" && !isTerminalToolPart(previous)) {
        yield* publishTranscript(info.sessionID, subagentEnd(part));
      }
      const native = partEvents(info, previous, part);
      if (native === undefined) {
        yield* publishTranscript(
          info.sessionID,
          partCompletionEvents(info, previous, part),
        );
        yield* publishSnapshots(info.sessionID);
      } else {
        yield* publishTranscript(info.sessionID, native);
      }
      if (
        part.type === "tool" &&
        childSessionId !== undefined &&
        (previous?.type !== "tool" ||
          toolDelegateSessionId(previous) === undefined)
      ) {
        const sessions = yield* Session.Service;
        const child = yield* sessions
          .readTranscriptPage({ sessionID: childSessionId })
          .pipe(Effect.orDie);
        yield* publishTranscript(info.sessionID, [
          subagentStart(part, child.session.title),
        ]);
        // Ancestors learn the child's Assistant headers; its input stays private.
        yield* publishTranscript(
          childSessionId,
          child.history
            .filter(({ info }) => info.role === "assistant")
            .flatMap(({ info }) => messageInfoEvent(info)),
        );
      }
      return;
    }
  }
});

/**
 * Supplies AG-UI delivery, capturing Session, Database, and Events.
 * Domain services provide committed facts; delivery never reads Permission or Run services.
 * @example
 * const runtime = application.pipe(Layer.provideMerge(layer));
 */
export const layer = Layer.effect(
  Publisher.Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service;
    const database = yield* Database.Service;
    const events = yield* Events.Service;
    return Publisher.Service.of({
      publish: (change) =>
        publishChange(change).pipe(
          Effect.provideService(Session.Service, sessions),
          Effect.provideService(Database.Service, database),
          Effect.provideService(Events.Service, events),
        ),
    });
  }),
);

/**
 * Publishes a Session's native snapshot under the Agent publication barrier.
 * Call after the shared event stream is ready, including after reconnect.
 * Earlier Agent changes are in this snapshot; later changes follow it on the bus.
 * Any waiting observer of this Session can initialize from it; live observers
 * ignore it. No durable replay is implied.
 * @example
 * yield* publishSnapshot(sessionID);
 */
export const publishSnapshot = Effect.fn("AgentSession.publishSnapshot")(
  function* (sessionID: string) {
    const sessions = yield* Session.Service;
    const events = yield* Events.Service;
    return yield* events.withBarrier(
      Effect.gen(function* () {
        const snapshot = yield* sessions.readSnapshot(sessionID);
        const projected = projectTree(
          sessionID,
          yield* readTree({
            session: snapshot.state.session,
            history: snapshot.history,
          }),
        );
        const initial: AGUIEvent[] = [
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: projected.messages,
          },
          {
            type: EventType.STATE_SNAPSHOT,
            snapshot: {
              ...snapshot.state,
              messageInfo: projected.messageInfo,
              history: { nextCursor: snapshot.nextCursor },
            },
          },
          ...projected.lifecycle,
          ...projected.open,
        ];
        yield* events.publish(AgentSnapshot, {
          sessionID,
          events: initial,
        });
      }),
    );
  },
);

/**
 * Publishes the first Session page before subsequent metadata changes on SSE.
 * The router supplies one shared page size for all directory observers.
 * This reads no transcript and starts no per-Session observation or execution.
 * @example
 * yield* bootstrapSessions(50);
 */
export const bootstrapSessions = Effect.fn("AgentSessions.bootstrap")(
  function* (limit: number) {
    const sessions = yield* Session.Service;
    const events = yield* Events.Service;
    yield* events.withBarrier(
      Effect.gen(function* () {
        const page = yield* sessions.list({
          limit,
          kinds: ["chat"],
          parentId: null,
          excludeArchived: true,
          orderBy: "updatedAt",
        });
        yield* events.publish(SessionListBootstrap, page);
      }),
    );
  },
);
