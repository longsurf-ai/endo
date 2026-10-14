import { Question } from "@openchart/server/agent/question";
// Purpose: Prepares one turn step and runs its model or deterministic stream through Processor.

import { readFileSync } from "node:fs";
import { toModelMessages } from "@openchart/server/agent/session/message/to-model-messages";
import { Permission } from "@openchart/server/agent/permission";
import { Processor } from "@openchart/server/agent/processor/processor";
import { Session } from "@openchart/server/agent/session/session";
import { ToolRegistry } from "@openchart/server/agent/tool/registry";
import { LLM } from "@openchart/server/agent/llm/llm";
import {
  toolCallStream,
  type AcceptedToolCall,
} from "@openchart/server/agent/llm/tool-call";
import { Clock, Effect, Schema } from "effect";
import { createAssistant } from "./assistant";
import { prepareStepHistory } from "./history";
import type { TurnStep } from "./execute";
import { bindTools } from "./tools";

const maximumSteps = readFileSync(
  new URL("./max-steps.txt", import.meta.url),
  "utf8",
);

/**
 * Projects request history, commits a fresh Assistant, and runs its Processor.
 * An accepted call replaces only this step's stream source. Normal model requests
 * and deterministic calls share tool binding, permissions, evidence, and cleanup.
 * Reminders stay ephemeral; tools receive the original committed history.
 * Processor retains request snapshots, retries, tool barriers and cleanup.
 * @example
 * yield* processStep({user, agent, model, messages, lastFinished, step});
 */
export const processStep = Effect.fn("Prompt.processStep")(function* (
  input: TurnStep,
  call?: AcceptedToolCall,
) {
  const session = yield* Session.Service;
  const registry = yield* ToolRegistry.Service;
  const permission = yield* Permission.Service;
  const question = yield* Question.Service;
  const definitions = yield* registry.all();
  const history = prepareStepHistory(input);
  const messages = yield* toModelMessages(history, input.model, {
    toolOutput: "clipped",
  });
  const assistant = yield* createAssistant(
    input.user,
    input.agent.name,
    input.model,
    input.cwd,
  );
  const processor = yield* Processor.create({
    assistantMessage: assistant,
    model: input.model,
  });
  const tools = bindTools({
    rootRunID: input.rootRunID,
    definitions,
    profile: input.agent,
    assistant,
    processor,
    messages: input.messages,
    session,
    permission,
    acceptedCallID: call?.callID,
  });
  const now = yield* Clock.currentTimeMillis;
  const execution = processor.process({
    model: input.model,
    cwd: input.cwd,
    user: input.user,
    outputSchema: input.outputSchema,
    agent: input.agent,
    sessionID: input.user.sessionID,
    system: [
      `You are powered by the model named ${input.model.id}. The exact model ID is ${input.model.providerID}/${input.model.id}`,
      `Today's date: ${new Date(now).toDateString()}`,
    ],
    messages: [
      ...messages,
      ...(input.agent.steps !== undefined && input.step >= input.agent.steps
        ? [{ role: "assistant" as const, content: maximumSteps }]
        : []),
    ],
    tools,
    askQuestion: (request) =>
      question.ask({ ...request, sessionID: input.user.sessionID }),
    askPermission: (request) =>
      Schema.decodeUnknownEffect(Schema.JsonObject)(request.metadata).pipe(
        Effect.flatMap((metadata) =>
          permission.ask({
            sessionID: input.user.sessionID,
            agent: null,
            action: request.permission,
            resources: request.patterns,
            save: request.always,
            metadata,
          }),
        ),
      ),
  });
  yield* call
    ? execution.pipe(Effect.provideService(LLM.Service, toolCallStream(call)))
    : execution;
});
