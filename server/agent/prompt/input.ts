// Purpose: Materializes one claimed prompt into a User and its complete input Parts.

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import type { User } from "@openchart/server/agent/contracts/message";
import type { Part } from "@openchart/server/agent/contracts/part";
import {
  SessionId,
  type Session as SessionInfo,
} from "@openchart/server/agent/contracts/session";
import { ascending } from "@openchart/identifier";
import { prepareEvidence } from "@openchart/server/agent/session/message/evidence";
import type { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session/session";
import { assertExists } from "@openchart/utils/assert";
import { Clock, Effect } from "effect";
import { UnsupportedInput } from "./errors";

/**
 * Commits the accepted input and materialized evidence in one Message write.
 * Unsupported executable intents fail before any partial transcript is written.
 * The Run's explicit model wins; a matching profile may supply its variant.
 * The first Dig In prompt receives its sole context marker from the parent anchor.
 * SessionExecution serializes prompt materialization within this Session.
 * @example
 * const user = yield* createUser(info, run.input, profile);
 */
export const createUser = Effect.fn("Prompt.createUser")(function* (
  info: SessionInfo,
  input: AgentPromptInput,
  profile: AgentProfile.Info,
) {
  const session = yield* Session.Service;
  const now = yield* Clock.currentTimeMillis;
  const variant =
    input.model.selectedVariant ??
    (profile.model?.providerID === input.model.providerID &&
    profile.model.modelID === input.model.modelID
      ? profile.selectedVariant
      : undefined);
  const user: User = {
    id: `msg_${ascending()}`,
    role: "user",
    sessionID: info.id,
    agent: input.agent,
    workspaceId: input.workspaceId,
    model: {
      ...input.model,
      ...(variant === undefined ? {} : { selectedVariant: variant }),
    },
    time: { created: now },
  };
  const parts: Part[] = yield* digInContext(info, user.id);
  for (const inputPart of input.parts) {
    const part = {
      ...structuredClone(inputPart),
      id: inputPart.id ?? `prt_${ascending()}`,
      messageID: user.id,
    };
    if (part.type === "subtask" || part.type === "agent") {
      return yield* new UnsupportedInput({
        type: part.type,
        detail:
          "This intent requires a feature runtime that is not available in V2.",
      });
    }
    if (part.type === "context" && part.context.kind === "dig_in") {
      return yield* new UnsupportedInput({
        type: "dig_in",
        detail:
          "Dig-in context is supplied by the child Session, not prompt input.",
      });
    }
    if (part.type === "file") {
      const url = yield* Effect.try({
        try: () => new URL(part.url),
        catch: () =>
          new UnsupportedInput({
            type: "file",
            detail: "The attachment URL is invalid.",
          }),
      });
      if (
        !["data:", "https:", "http:"].includes(url.protocol) ||
        part.mime === "application/x-directory"
      ) {
        return yield* new UnsupportedInput({
          type: "file",
          detail:
            "Local files and directories require the unmigrated sandbox runtime.",
        });
      }
      if (part.mime === "text/plain") {
        if (url.protocol !== "data:")
          return yield* new UnsupportedInput({
            type: "file",
            detail:
              "Text attachments must contain their content in a data URL.",
          });
        const text = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(url, { signal }).then((response) => response.text()),
          catch: () =>
            new UnsupportedInput({
              type: "file",
              detail: "The attachment text encoding is invalid.",
            }),
        });
        parts.push({
          id: `prt_${ascending()}`,
          messageID: user.id,
          type: "text",
          synthetic: true,
          text,
        });
      }
    }
    parts.push(part);
    if (
      part.type === "context" &&
      part.context.kind === "document" &&
      part.context.evidence
    ) {
      parts.push(...prepareEvidence(part.context.evidence, part, now).parts);
    }
  }
  yield* session.createMessage({ info: user, parts });
  return user;
});

const digInContext = Effect.fn("Prompt.digInContext")(function* (
  info: SessionInfo,
  messageID: string,
) {
  if (info.kind !== "dig_in") return [];
  const sessions = yield* Session.Service;
  const { history } = yield* sessions.readTranscriptPage({
    sessionID: info.id,
  });
  if (history.length > 0) return [];
  assertExists(info.parentId, "A Dig In must have a parent Session");
  const parent = yield* sessions.get(SessionId.make(info.parentId));
  const anchor = parent?.anchors?.find(
    (anchor) => anchor.childSessionId === info.id,
  );
  assertExists(anchor, "A Dig In must have a parent selection anchor");
  return [
    {
      id: `prt_${ascending()}`,
      messageID,
      type: "context",
      context: { kind: "dig_in", quoteText: anchor.text },
    },
  ] satisfies Part[];
});
