// Purpose: Owns text transcript Parts and their timing and metadata.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical text part schema for agent transcript content. */
export const TextPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("text"),
  text: Schema.String,
  // Synthetic text remains model context but is absent from the visible transcript.
  synthetic: Schema.optional(Schema.Boolean),

  time: Schema.optional(
    Schema.Struct({
      start: Schema.Finite,
      end: Schema.optional(Schema.Finite),
    })
      .mapFields(Struct.map(Schema.mutableKey))
      .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  ),
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "TextPart",
  });
/** Parsed text part value. */
export type TextPart = typeof TextPart.Type;
