// Purpose: Owns the stored "run this Agent prompt" target shared by Schedules and Triggers.

import { Schema, Struct } from "effect";
import { checkPromptConstraint } from "@openchart/agent/prompt-constraint";

import { AgentPromptInput } from "./agent-prompt-input";

/**
 * Durable instruction to admit one Agent prompt; its owner decides when.
 * Saved prompt Parts follow composer order; execution may append context before
 * admission. The optional binding key is an opaque feature-owned string that
 * selects a reusable Session.
 * Unknown fields fail parsing at every level.
 *
 * @example
 * ```ts
 * const target = Schema.decodeUnknownSync(AgentPromptTarget)({
 *   kind: "agent_prompt",
 *   prompt: {
 *     agent: "analyst",
 *     model: {providerID: "codex", modelID: "tier1"},
 *     parts: [{type: "text", text: "Review the alert."}],
 *   },
 * });
 * ```
 */
export const AgentPromptTarget = Schema.Struct({
  kind: Schema.Literal("agent_prompt"),
  prompt: AgentPromptInput.check(Schema.makeFilter(checkPromptConstraint)),
  binding: Schema.optional(
    Schema.Struct({
      key: Schema.String.check(Schema.isMinLength(1)),
    })
      .mapFields(Struct.map(Schema.mutableKey))
      .annotate({ parseOptions: { onExcessProperty: "error" } }),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });
/** Complete stored prompt and optional feature binding. */
export type AgentPromptTarget = typeof AgentPromptTarget.Type;
