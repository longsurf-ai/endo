// Purpose: Compacts prompt history with a durable summary seal.

import type {
  Assistant,
  User,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import { ascending } from "@openchart/identifier";
import type { AvailableModel } from "@openchart/models/model-provider";
import { toModelMessages } from "@openchart/server/agent/session/message/to-model-messages";
import { Processor } from "@openchart/server/agent/processor/processor";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session/session";
import { Models } from "@openchart/server/models";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Clock, Effect } from "effect";
import { createAssistant } from "./assistant";
import { serializeCompactionHistory } from "./compaction-input";
import { ProfileNotFound } from "./errors";
import { derivePromptLoopAnchors, isUsableSummary } from "./history";
import type { TurnStep } from "./execute";

const SUMMARY_PROMPT =
  "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation.";

const MAX_INPUT_TOKENS = 250_000;
const CHARS_PER_TOKEN = 4;

/** V1's 250k input ceiling within the model's input room, reserving at most 32k output. */
function inputTokenBudget(limit: AvailableModel["limit"]): number {
  if (!limit) return MAX_INPUT_TOKENS;
  const output = limit.output > 0 ? Math.min(limit.output, 32_000) : 32_000;
  const budget = Math.min(
    MAX_INPUT_TOKENS,
    limit.context,
    limit.input ?? limit.context - output,
  );
  return Math.max(0, budget);
}

/**
 * Detects overflow before the next request against the input token budget.
 * Unknown capacity cannot trigger compaction.
 * The estimate uses the clipped replay projection: provider usage may aggregate
 * inner requests and therefore cannot measure the current context window.
 * @example
 * if (yield* needsCompaction(messages, model)) yield* compact({messages, user, model});
 */
export const needsCompaction = Effect.fn("Prompt.needsCompaction")(function* (
  messages: WithParts[],
  model: AvailableModel,
) {
  const { lastFinished } = derivePromptLoopAnchors(messages);
  if (!model.limit || !lastFinished || lastFinished.summary) return false;
  const threshold = inputTokenBudget(model.limit);
  if (threshold <= 0) return false;
  const projected = yield* toModelMessages(messages, model, {
    toolOutput: "clipped",
  });
  // Binary attachment bytes are not prompt text. Estimate their framing only.
  const characters = JSON.stringify(projected, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "type" in value) {
      if (value.type === "file" && "mediaType" in value && "data" in value)
        return { ...value, data: "[attachment]" };
      if (value.type === "image" && "image" in value)
        return { ...value, image: "[attachment]" };
    }
    if (typeof value === "string" && value.startsWith("data:"))
      return `${value.slice(0, value.indexOf(",") + 1)}[attachment]`;
    if (value instanceof Uint8Array) return "[attachment]";
    return value;
  }).length;
  return Math.round(characters / CHARS_PER_TOKEN) >= threshold;
});

/**
 * Streams a tool-less summary for an existing manual marker, or appends an
 * automatic marker. Only automatic compaction resumes the interrupted task.
 * Only a successful visible stop can seal the boundary. The continuation is
 * committed first, so an interrupted or failed seal keeps the original history.
 * Model and persistence failures propagate to the run owner unchanged.
 * @example
 * yield* compact({messages, user, model, cwd});
 * const nextHistory = yield* readHistory(user.sessionID);
 */
export const compact = Effect.fn("Prompt.compact")(function* (
  input: Pick<TurnStep, "messages" | "user" | "model" | "cwd">,
  auto = true,
) {
  const session = yield* Session.Service;
  const { agent, model } = yield* resolveCompactionAgent(input.model);
  const { user, messages } = yield* prepareCompactionHistory(input, auto);
  const assistant = yield* generateSummary({
    ...input,
    user,
    messages,
    agent,
    model,
  });
  const summary = yield* prepareSummaryCommit(assistant);
  if (auto) yield* appendContinuation(user);

  // Commit success last. Earlier failures keep the source history available.
  yield* session.updateMessage(summary);
});

const resolveCompactionAgent = Effect.fn("Prompt.resolveCompactionAgent")(
  function* (fallbackModel: AvailableModel) {
    const profiles = yield* AgentProfile.Service;
    const agent = yield* profiles.resolve("compaction");
    if (!agent)
      return yield* Effect.fail(new ProfileNotFound({ name: "compaction" }));
    const selection = agent.model;
    const model = selection
      ? yield* Models.Service.use((models) =>
          models.getModel(selection.providerID, selection.modelID),
        )
      : fallbackModel;
    return { agent, model };
  },
);

const prepareCompactionHistory = Effect.fn("Prompt.prepareCompactionHistory")(
  function* (input: Pick<TurnStep, "user" | "messages">, auto: boolean) {
    if (!auto) return { user: input.user, messages: input.messages };
    const session = yield* Session.Service;
    const user: User = {
      ...input.user,
      id: `msg_${ascending()}`,
      time: { created: yield* Clock.currentTimeMillis },
    };
    const marker = yield* session.createMessage({
      info: user,
      parts: [
        {
          id: `prt_${ascending()}`,
          messageID: user.id,
          type: "compaction",
          auto: true,
        },
      ],
    });
    return { user, messages: [...input.messages, marker] };
  },
);

const generateSummary = Effect.fn("Prompt.generateSummary")(function* (
  input: Pick<TurnStep, "user" | "messages" | "agent" | "model" | "cwd">,
) {
  const { user, agent, model, cwd } = input;
  const assistant = yield* createAssistant(user, agent.name, model, cwd);
  const processor = yield* Processor.create({
    assistantMessage: assistant,
    model,
  });
  const prompt = [
    "Here is the conversation so far:",
    "<conversation>",
    // The summary model never receives more than a normal turn may send it.
    serializeCompactionHistory(
      input.messages,
      inputTokenBudget(model.limit) * CHARS_PER_TOKEN,
    ),
    "</conversation>",
    SUMMARY_PROMPT,
  ].join("\n\n");
  yield* processor.process({
    model,
    cwd,
    user: {
      id: user.id,
      model: agent.model
        ? {
            ...agent.model,
            ...(agent.selectedVariant
              ? { selectedVariant: agent.selectedVariant }
              : {}),
          }
        : user.model,
    },
    sessionID: user.sessionID,
    agent,
    tools: {},
    system: [],
    messages: [{ role: "user", content: prompt }],
  });
  return assistant;
});

const prepareSummaryCommit = Effect.fn("Prompt.prepareSummaryCommit")(
  function* (assistant: Assistant) {
    const session = yield* Session.Service;
    const summary = yield* session.getMessage({
      sessionID: assistant.sessionID,
      messageID: assistant.id,
    });
    assertExists(summary, "Completed compaction message is missing");
    assertTrue(
      summary.info.role === "assistant",
      "Compaction must be an Assistant",
    );
    // Validate the final header before writing it; the stored message stays unsealed.
    const candidate: Assistant = { ...summary.info, summary: true };
    if (isUsableSummary({ ...summary, info: candidate })) return candidate;
    const error: NonNullable<Assistant["error"]> =
      summary.info.finish === "length"
        ? { name: "MessageOutputLengthError", data: {} }
        : {
            name: "UnknownError",
            data: {
              message: `Compaction summary was unusable (finish: ${summary.info.finish ?? "missing"})`,
            },
          };
    yield* session.updateMessage({ ...summary.info, error });
    return yield* Effect.fail(error);
  },
);

const appendContinuation = Effect.fn("Prompt.appendContinuation")(function* (
  marker: User,
) {
  const session = yield* Session.Service;
  const continuation: User = {
    ...marker,
    id: `msg_${ascending()}`,
    time: { created: yield* Clock.currentTimeMillis },
  };
  yield* session.createMessage({
    info: continuation,
    parts: [
      {
        id: `prt_${ascending()}`,
        messageID: continuation.id,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
      },
    ],
  });
});
