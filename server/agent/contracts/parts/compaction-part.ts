// Purpose: Owns transcript markers for context compaction.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical compaction part schema for agent transcript content. */
export const CompactionPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "CompactionPart",
  });
/** Parsed compaction part value. */
export type CompactionPart = typeof CompactionPart.Type;
