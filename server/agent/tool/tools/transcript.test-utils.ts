// Purpose: Seeds Sessions and transcript messages with explicit SQL timestamps for transcript tool tests.

import { ascending } from "@openchart/identifier";
import type { WithParts } from "@openchart/server/agent/contracts/message";
import type { Part } from "@openchart/server/agent/contracts/part";
import {
  SessionId,
  type SessionKind,
} from "@openchart/server/agent/contracts/session";
import { agentMessages, agentSessions } from "@openchart/server/agent/schema";
import { Session } from "@openchart/server/agent/session";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Database } from "@openchart/server/db";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";

/** Default Session the fixtures write into. */
export const SOURCE = "ses_source";

/** In-memory Database plus Session operations, enough to seed and read transcripts. */
export const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Session.layer,
      Database.layer(":memory:", () => Effect.void),
    ),
  );

/** A text Part, optionally synthetic. */
export const text = (
  messageID: string,
  value: string,
  synthetic = false,
): Part => ({
  id: `prt_${ascending()}`,
  messageID,
  type: "text",
  text: value,
  ...(synthetic ? { synthetic } : {}),
});

/** A User message with the given Parts. */
export const user = (
  id: string,
  parts: Part[],
  sessionID = SOURCE,
): WithParts => ({
  info: {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "analyst",
    model: { providerID: "openai", modelID: "test" },
  },
  parts,
});

/** An Assistant message with the given Parts. */
export const assistant = (
  id: string,
  parts: Part[],
  sessionID = SOURCE,
): WithParts => ({
  info: {
    id,
    sessionID,
    role: "assistant",
    triggeringUserMessageID: "msg_trigger",
    providerID: "openai",
    modelID: "test",
    agent: "analyst",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 },
  },
  parts,
});

/**
 * Inserts a Session and its messages, pinning each message's SQL creation time
 * and optionally the Session's kind and update time.
 * @example
 * yield* seed("ses_a", "Rates", [[user("msg_1", [text("msg_1", "hi")]), 1000]]);
 */
export const seed = (
  sessionID: string,
  title: string,
  messages: readonly (readonly [WithParts, number])[],
  options: { readonly kind?: SessionKind; readonly updatedAt?: number } = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service;
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* sessionStore.insert(tx, {
          id: SessionId.make(sessionID),
          parentId: null,
          kind: options.kind ?? "chat",
          bindingId: null,
          anchors: null,
          title,
          compactingAt: null,
          archivedAt: null,
        });
        for (const [message, createdAt] of messages) {
          yield* messageStore.insert(tx, message);
          yield* tx
            .update(agentMessages)
            .set({ createdAt })
            .where(eq(agentMessages.id, message.info.id));
        }
        if (options.updatedAt !== undefined)
          yield* tx
            .update(agentSessions)
            .set({ updatedAt: options.updatedAt })
            .where(eq(agentSessions.id, sessionID));
      }),
    );
  });
