// Purpose: Owns transcript markers for completed model steps and usage.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical step finish part schema for agent transcript content. */
export const StepFinishPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    })
      .mapFields(Struct.map(Schema.mutableKey))
      .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "StepFinishPart",
  });
/** Parsed step finish part value. */
export type StepFinishPart = typeof StepFinishPart.Type;
