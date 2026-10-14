// Purpose: Owns tool transcript Parts, lifecycle states, and model-facing output.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";
import { FilePart } from "./file-part";

const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

const MediaContent = Schema.Struct({
  type: Schema.Literal("media"),
  mediaType: Schema.String.check(Schema.isMinLength(1)),
  data: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** Canonical tool model content schema for agent transcript content. */
export const ToolModelContent = Schema.Union([TextContent, MediaContent]);
/** Parsed tool model content value. */
export type ToolModelContent = typeof ToolModelContent.Type;

/** Canonical tool model output schema for agent transcript content. */
export const ToolModelOutput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), value: Schema.String })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Json })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    type: Schema.Literal("content"),
    value: Schema.Array(ToolModelContent).pipe(Schema.mutable),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
]).annotate({ identifier: "ToolModelOutput" });
/** Parsed tool model output value. */
export type ToolModelOutput = typeof ToolModelOutput.Type;

/** Canonical tool input schema for agent transcript content. */
export const ToolInput = Schema.Record(
  Schema.String,
  Schema.mutableKey(Schema.Any),
).annotate({ identifier: "ToolInput" });
/** Parsed tool input value. */
export type ToolInput = typeof ToolInput.Type;

/** Canonical tool error input schema for agent transcript content. */
export const ToolErrorInput = Schema.Json;
/** Parsed tool error input value. */
export type ToolErrorInput = typeof ToolErrorInput.Type;

/** Pending calls retain input and metadata, never raw input fragments. */
export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: ToolInput,
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "ToolStatePending",
  });

/** Parsed tool state pending value. */
export type ToolStatePending = typeof ToolStatePending.Type;

/** Canonical tool state running schema for agent transcript content. */
export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: ToolInput,
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  ),
  time: Schema.Struct({
    start: Schema.Finite,
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "ToolStateRunning",
  });
/** Parsed tool state running value. */
export type ToolStateRunning = typeof ToolStateRunning.Type;

/** Canonical tool state completed schema for agent transcript content. */
export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: ToolInput,

  // @agent invariant: model-facing tool results remain typed through
  // persistence and replay; JSON must never be stored as escaped text.
  output: ToolModelOutput,
  title: Schema.String,
  // Tool execution details, e.g. {pagesRead: 3, matches: 12}.
  metadata: Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  time: Schema.Struct({
    start: Schema.Finite,
    end: Schema.Finite,
    compacted: Schema.optional(Schema.Finite),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  attachments: Schema.optional(Schema.Array(FilePart).pipe(Schema.mutable)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "ToolStateCompleted",
  });
/** Parsed tool state completed value. */
export type ToolStateCompleted = typeof ToolStateCompleted.Type;

/** Canonical tool state error schema for agent transcript content. */
export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  // @agent invariant: only terminal tool errors may preserve a non-object
  // JSON input. Executable and completed tool states require ToolInput.
  input: ToolErrorInput,
  error: Schema.String,
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  ),
  time: Schema.Struct({
    start: Schema.Finite,
    end: Schema.Finite,
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "ToolStateError",
  });
/** Parsed tool state error value. */
export type ToolStateError = typeof ToolStateError.Type;

/** Canonical tool state schema for agent transcript content. */
export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]).annotate({
  identifier: "ToolState",
});
/** Parsed tool state value. */
export type ToolState = typeof ToolState.Type;

/** Canonical tool part schema for agent transcript content. */
export const ToolPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,

  // Provider protocol data retained for model replay, e.g.
  // {openai: {itemId: 'fc_123'}}. Tool execution details live in state.metadata.
  providerMetadata: Schema.optional(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  ),

  // ToolPart          Direct child OpenChart Sessions       childSessionIds
  // ----------------------------------------------------------------------
  // ordinary tool     (none)                                []
  // task ------------> A                                    [A]
  // workflow ----+---> A                                    [A, B]
  //              +---> B
  //              '---> A (resume: same Session, new span)
  // provider proxy --> P (local transcript projection)      [P]
  //
  // All start with []. Task/workflow link children before execution through
  // ctx.metadata; workflow UI uses spans for individual calls.
  // Provider owns its subagent execution; Processor creates and links P on
  // the provider's start event. P is a local ID, not a provider Session ID.
  // Links are unique and survive terminal states; no descendants or status.
  childSessionIds: Schema.UniqueArray(
    Schema.String.check(Schema.isMinLength(1)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "ToolPart" });
/** Parsed tool part value. */
export type ToolPart = typeof ToolPart.Type;
