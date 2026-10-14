// Purpose: Creates fresh Assistant headers for prompt and compaction requests.

import type {
  Assistant,
  User,
} from "@openchart/server/agent/contracts/message";
import { ascending } from "@openchart/identifier";
import type { AvailableModel } from "@openchart/models/model-provider";
import { Session } from "@openchart/server/agent/session/session";
import { Clock, Effect } from "effect";

/**
 * Commits an empty Assistant before its Processor is constructed.
 * @example
 * const assistant = yield* createAssistant(user, profile.name, model, cwd);
 */
export const createAssistant = Effect.fn("Prompt.createAssistant")(function* (
  user: User,
  agent: string,
  model: AvailableModel,
  cwd: string,
) {
  const session = yield* Session.Service;
  const assistant: Assistant = {
    id: `msg_${ascending()}`,
    sessionID: user.sessionID,
    role: "assistant",
    triggeringUserMessageID: user.id,
    agent,
    modelID: model.id,
    providerID: model.providerID,
    path: { cwd, root: cwd },
    time: { created: yield* Clock.currentTimeMillis },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  yield* session.createMessage({ info: assistant, parts: [] });
  return assistant;
});
