// Purpose: Owns transcript Parts selecting an agent.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Canonical agent part schema for agent transcript content. */
export const AgentPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: Schema.Finite.check(Schema.isInt()),
      end: Schema.Finite.check(Schema.isInt()),
    })
      .mapFields(Struct.map(Schema.mutableKey))
      .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "AgentPart",
  });
/** Parsed agent part value. */
export type AgentPart = typeof AgentPart.Type;
