// Purpose: Owns reasoning transcript Parts and their timing and metadata.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical reasoning part schema for agent transcript content. */
export const ReasoningPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  ),
  time: Schema.Struct({
    start: Schema.Finite,
    end: Schema.optional(Schema.Finite),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "ReasoningPart",
  });
/** Parsed reasoning part value. */
export type ReasoningPart = typeof ReasoningPart.Type;
