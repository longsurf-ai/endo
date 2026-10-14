// Purpose: Owns the sole frontend Agent prompt input contract.

import { Schema, Struct } from "effect";
import {
  MODEL_PROVIDER_IDS,
  MODEL_TIER_IDS,
} from "@openchart/models/model-tiers";
import * as Part from "./part";

/** Supported provider and logical tier frozen into an accepted prompt. */
export const AgentPromptModel = Schema.Struct({
  providerID: Schema.Literals(MODEL_PROVIDER_IDS),
  modelID: Schema.Literals(MODEL_TIER_IDS),
  selectedVariant: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** Product model selection; execution resolves its tier to a native SDK model. */
export type AgentPromptModel = typeof AgentPromptModel.Type;

function toPromptPartInput<
  Fields extends Schema.Struct.Fields &
    Pick<typeof Part.TextPart.fields, "id" | "messageID">,
>(part: Schema.Struct<Fields>, ref: string) {
  return part
    .mapFields((fields) => ({
      ...Struct.omit(fields, ["id", "messageID"]),
      id: Schema.optional(fields.id),
    }))
    .annotate({ ...part.ast.annotations, identifier: ref });
}

/** Input-capable transcript variants; identity is assigned on materialization. */
export const AgentPromptPartInput = Schema.Union([
  toPromptPartInput(Part.TextPart, "TextPartInput"),
  toPromptPartInput(Part.FilePart, "FilePartInput"),
  toPromptPartInput(Part.ContextPart, "ContextPartInput"),
  toPromptPartInput(Part.PluginInputPart, "PluginInputPartInput"),
  toPromptPartInput(Part.AgentPart, "AgentPartInput"),
  toPromptPartInput(Part.SubtaskPart, "SubtaskPartInput"),
  toPromptPartInput(Part.WorkflowPart, "WorkflowPartInput"),
  toPromptPartInput(Part.CompactionPart, "CompactionPartInput"),
]).annotate({ identifier: "AgentPromptPartInput" });
/** Parsed input part with optional caller-supplied part identity. */
export type AgentPromptPartInput = typeof AgentPromptPartInput.Type;

// @agent invariant: This is the only schema for content stored in
// agent_run.input. Queue storage must be a complete execution snapshot and
// must not carry session or message identity.
// Scheduled runs use this same snapshot contract.
const AgentPromptInputFields = {
  // Which agent profile to select. Currently we only provide the default
  // analyst agent.
  agent: Schema.String.check(Schema.isMinLength(1)),

  // Which workspace this agent should be running. When not provided we
  // run the agent in the default workspace.
  workspaceId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),

  // The parts to trigger the agent. Input to the model.
  parts: Schema.Array(AgentPromptPartInput)
    .pipe(Schema.mutable)
    .check(
      Schema.isMinLength(1, {
        message: "Prompt must include at least one part",
      }),
    ),
};

function refineAgentPromptParts(input: {
  parts: AgentPromptPartInput[];
}): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = [];
  const workflows = input.parts.filter((part) => part.type === "workflow");
  if (workflows.length > 1) {
    issues.push({
      path: ["parts"],
      issue: "A prompt may contain at most one WorkflowPart",
    });
  }
  if (
    workflows.length > 0 &&
    input.parts.some((part) => part.type === "subtask")
  ) {
    issues.push({
      path: ["parts"],
      issue: "WorkflowPart and SubtaskPart cannot coexist in one prompt",
    });
  }
  if (input.parts.some((part) => part.type === "compaction" && part.auto)) {
    issues.push({
      path: ["parts"],
      issue: "Prompt compaction must be manual",
    });
  }
  return issues;
}

/**
 * Sole frontend Agent prompt input, shared by direct and scheduled admission.
 * Every feature requesting Agent work expresses its intent through this shape.
 * This schema owns the contract; the frontend infers it through AppRouter.
 *
 * The same prompt value crosses each boundary:
 *
 * ```text
 * Direct request                     Scheduled target (contract)
 * PromptRequest.input                AgentPromptTarget.prompt
 *          |                                     |
 *          +------------------+------------------+
 *                             v
 *                     AgentPromptInput
 *                             |
 *                     accepted run stores
 *                             v
 *                      agent_run.input
 *                             |
 *                       claim queued run
 *                             v
 *                    prompt.execute(run)
 * ```
 *
 * What one prompt carries:
 *
 * ```text
 * AgentPromptInput
 * |-- agent                      Agent selected to handle this request
 * |-- workspaceId?               Workspace selection; parent or Home default if omitted
 * |-- model                      Product model selection for this run
 * |   |-- providerID             Supported provider identity
 * |   |-- modelID                Logical tier1 through tier5
 * |   `-- selectedVariant?       Variant when explicitly selected
 * `-- parts[]                    Ordered, non-empty input content / intent
 *     |-- text                   Prompt text
 *     |-- file                   File or image attachment
 *     |-- context                Resource, document, session, quote, dig-in, plugin
 *     |-- plugin_input           Structured feature input
 *     |-- agent                  Agent reference within the prompt
 *     |-- subtask                Delegated work request
 *     |-- workflow               Workflow identity and public arguments
 *     `-- compaction             Manual context compaction
 * ```
 *
 * Session routing and intent deduplication belong to the surrounding request;
 * run identity and queue state belong to the run. None are prompt fields.
 * IDs inside context may reference other objects; they do not assign ownership
 * of this prompt. Each input variant derives from its transcript Part schema:
 *
 * ```text
 * transcript Part -> omit messageID -> make id optional
 *                 -> AgentPromptPartInput
 * ```
 *
 * A supplied Part ID stays stable; absent ownership/identity is assigned when
 * materializing the transcript. Plugin context is accepted through ContextPart;
 * its kind does not prove who supplied it. Other runtime output Part variants
 * are not accepted input.
 *
 * The schema requires an explicit agent and model, at least one Part, at most
 * one workflow, no workflow/subtask mixture, and manual compaction input. Extra
 * top-level fields fail parsing. Accepted prompts are immutable execution
 * snapshots by contract; this schema does not freeze JavaScript objects. Later
 * UI or default-model changes must not rewrite queued input.
 *
 * V2 implements direct admission through Runner and Prompt, transcript
 * materialization and model execution. Executable feature intents whose owners
 * have not migrated fail explicitly in Prompt; admission retains their contract.
 *
 * @example
 * ```ts
 * const input = Schema.decodeUnknownSync(AgentPromptInput)({
 *   agent: 'analyst',
 *   model: {providerID: 'codex', modelID: 'tier4'},
 *   parts: [{type: 'text', text: 'Explain this chart.'}],
 * });
 * // Direct admission wraps this as {sessionID, sessionIntentID, input}.
 * // A schedule target stores the same shape in its `prompt` field.
 * ```
 */
export const AgentPromptInput = Schema.Struct({
  ...AgentPromptInputFields,
  model: AgentPromptModel,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .check(Schema.makeFilter(refineAgentPromptParts))
  .annotate({
    identifier: "AgentPromptInput",
    parseOptions: { onExcessProperty: "error" },
  });
/** Parsed immutable prompt stored on an accepted run. */
export type AgentPromptInput = typeof AgentPromptInput.Type;
