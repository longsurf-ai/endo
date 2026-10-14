// Purpose: Aggregates transcript Part schemas and owns their complete union.

import { Schema } from "effect";
import { TextPart } from "@openchart/server/agent/contracts/parts/text-part";
import { SubtaskPart } from "@openchart/server/agent/contracts/parts/subtask-part";
import { WorkflowPart } from "@openchart/server/agent/contracts/parts/workflow-part";
import { ReasoningPart } from "@openchart/server/agent/contracts/parts/reasoning-part";
import { FilePart } from "@openchart/server/agent/contracts/parts/file-part";
import { ContextPart } from "@openchart/server/agent/contracts/parts/context-part";
import { PluginInputPart } from "@openchart/server/agent/contracts/parts/plugin-input-part";
import { ToolPart } from "@openchart/server/agent/contracts/parts/tool-part";
import { EvidencePart } from "@openchart/server/agent/contracts/parts/evidence-part";
import { StepStartPart } from "@openchart/server/agent/contracts/parts/step-start-part";
import { StepFinishPart } from "@openchart/server/agent/contracts/parts/step-finish-part";
import { AgentPart } from "@openchart/server/agent/contracts/parts/agent-part";
import { CompactionPart } from "@openchart/server/agent/contracts/parts/compaction-part";

export * from "@openchart/server/agent/contracts/parts/text-part";
export * from "@openchart/server/agent/contracts/parts/reasoning-part";
export * from "@openchart/server/agent/contracts/parts/file-part";
export * from "@openchart/server/agent/contracts/parts/context-part";
export * from "@openchart/server/agent/contracts/parts/plugin-input-part";
export * from "@openchart/server/agent/contracts/parts/agent-part";
export * from "@openchart/server/agent/contracts/parts/compaction-part";
export * from "@openchart/server/agent/contracts/parts/subtask-part";
export * from "@openchart/server/agent/contracts/parts/workflow-part";
export * from "@openchart/server/agent/contracts/parts/step-start-part";
export * from "@openchart/server/agent/contracts/parts/step-finish-part";
export * from "@openchart/server/agent/contracts/parts/tool-part";
export * from "@openchart/server/agent/contracts/parts/evidence-part";

// @agent invariant: Preserve all transcript variants and their nested content.
/** Canonical part schema for agent transcript content. */
export const Part = Schema.Union([
  TextPart,
  SubtaskPart,
  WorkflowPart,
  ReasoningPart,
  FilePart,
  ContextPart,
  PluginInputPart,
  ToolPart,
  EvidencePart,
  StepStartPart,
  StepFinishPart,
  AgentPart,
  CompactionPart,
]).annotate({
  identifier: "Part",
});
/** Parsed part value. */
export type Part = typeof Part.Type;
