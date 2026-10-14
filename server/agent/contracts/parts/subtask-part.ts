// Purpose: Owns transcript Parts requesting delegated agent work.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical subtask part schema for agent transcript content. */
export const SubtaskPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
    })
      .mapFields(Struct.map(Schema.mutableKey))
      .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  ),
  command: Schema.optional(Schema.String),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "SubtaskPart",
  });
/** Parsed subtask part value. */
export type SubtaskPart = typeof SubtaskPart.Type;
