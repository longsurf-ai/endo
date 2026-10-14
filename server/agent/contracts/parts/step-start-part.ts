// Purpose: Owns transcript markers for the start of a model step.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical step start part schema for agent transcript content. */
export const StepStartPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "StepStartPart",
  });
/** Parsed step start part value. */
export type StepStartPart = typeof StepStartPart.Type;
