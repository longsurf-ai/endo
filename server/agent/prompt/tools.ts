// Purpose: Binds invocation permissions, progress, and evidence to the existing tool catalog.

import type {
  Assistant,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import { prepareEvidence } from "@openchart/server/agent/session/message/evidence";
import type { LLM } from "@openchart/server/agent/llm/llm";
import { Permission } from "@openchart/server/agent/permission";
import { match } from "@openchart/server/agent/permission/rules";
import type { Processor } from "@openchart/server/agent/processor/processor";
import type { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session/session";
import type { Tool } from "@openchart/server/agent/tool/tool";
import { assertExists } from "@openchart/utils/assert";
import { Clock, Effect, type Schema } from "effect";

/**
 * Exposes permitted definitions with callbacks belonging to this Assistant only.
 * Processor invokes these callbacks after committing their ToolParts. Evidence
 * commits before its references become a tool result consumed by the model.
 * @example
 * const tools = bindTools({definitions, profile, assistant, processor, messages, session, permission});
 */
export function bindTools<R>(input: {
  rootRunID: string;
  definitions: readonly Tool.Def<
    Schema.Decoder<unknown>,
    Tool.Metadata,
    unknown,
    R
  >[];
  profile: AgentProfile.Info;
  assistant: Assistant;
  processor: Processor.Interface;
  messages: WithParts[];
  session: Session.Interface;
  permission: Permission.Interface;
  /** Every permission request from this call ID is allowed within this step. */
  acceptedCallID?: string;
}) {
  const bind = (definition: (typeof input.definitions)[number]) => ({
    description: definition.description,
    parameters: definition.parameters,
    formatValidationError: definition.formatValidationError,
    execute: (args: unknown, { toolCallId }: LLM.ToolExecutionOptions) =>
      Effect.gen(function* () {
        const source = {
          type: "tool" as const,
          messageID: input.assistant.id,
          callID: toolCallId,
        };
        const identity = {
          sessionID: input.assistant.sessionID,
          agent: input.profile.name,
          source,
        };
        const { evidence, ...result } = yield* definition.execute(args, {
          rootRunID: input.rootRunID,
          sessionID: input.assistant.sessionID,
          messageID: input.assistant.id,
          callID: toolCallId,
          agent: input.profile.name,
          messages: input.messages,
          metadata: (progress) =>
            input.processor.updateToolProgress(toolCallId, progress),
          ask: (request) =>
            toolCallId === input.acceptedCallID
              ? Effect.void
              : input.permission.ask({
                  ...identity,
                  action: request.permission,
                  resources: request.patterns,
                  save: request.always,
                  metadata: request.metadata,
                }),
        });
        if (!evidence?.length) return result;
        const message = yield* input.session.getMessage({
          sessionID: input.assistant.sessionID,
          messageID: input.assistant.id,
        });
        const part = message?.parts.find(
          (part) => part.type === "tool" && part.callID === toolCallId,
        );
        assertExists(
          part,
          "Executing tool evidence requires its committed ToolPart",
        );
        const prepared = prepareEvidence(
          evidence,
          part,
          yield* Clock.currentTimeMillis,
        );
        for (const evidencePart of prepared.parts)
          yield* input.session.createPart(evidencePart);
        return {
          ...result,
          output: { type: "text" as const, value: prepared.modelOutput },
        };
      }),
  });
  /**
   * Keeps the full catalog for an accepted call. Model steps omit a tool only
   * when the last matching profile rule denies it for every resource.
   * Permission checks for individual calls remain in ctx.ask.
   */
  const shouldExcludeTool = (toolID: string) => {
    if (input.acceptedCallID !== undefined) return false;
    const rule = [...input.profile.permission]
      .reverse()
      .find((rule) => match(toolID, rule.action));
    return rule?.resource === "*" && rule.decision === "deny";
  };

  const tools: Record<string, ReturnType<typeof bind>> = {};
  for (const definition of input.definitions) {
    if (shouldExcludeTool(definition.id)) continue;
    tools[definition.id] = bind(definition);
  }
  return tools;
}
