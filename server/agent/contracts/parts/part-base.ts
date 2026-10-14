// Purpose: Owns shared transcript Part identity and message ownership.

import { Schema, Struct } from "effect";

/** Shared identity and message ownership fields extended by every Part. */
// @agent invariant: A Part's Session is determined only by its owning Message.
export const PartBase = Schema.Struct({
  id: Schema.String,
  messageID: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } });
