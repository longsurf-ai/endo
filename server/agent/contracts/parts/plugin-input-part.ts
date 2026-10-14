// Purpose: Owns plugin input Parts and their accepted input variants.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

/** Parsed plugin input value: a JSON object tagged by a non-empty `type`. */
export type PluginInput = {
  readonly type: string;
  readonly [field: string]: Schema.Json;
};

/**
 * Canonical plugin input schema for agent transcript content.
 *
 * A plugin input is a JSON object tagged by a non-empty `type`. The registry
 * rejects an input whose type no selected plugin owns, and the owning plugin
 * decodes its remaining fields in `run.before`. Applications that want static
 * per-plugin validation may replace this with a union of tagged structs, e.g.
 * `Schema.Union([MyFeaturePluginInput])`.
 * @example
 * Schema.decodeUnknownSync(PluginInput)({ type: "ticket_context", ticketId: "T-1" });
 */
export const PluginInput: Schema.Codec<PluginInput> = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Trim.check(Schema.isMinLength(1)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
).annotate({ identifier: "PluginInput" });

/** Canonical plugin input part schema for agent transcript content. */
export const PluginInputPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("plugin_input"),
  input: PluginInput,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "PluginInputPart",
  });
/** Parsed plugin input part value. */
export type PluginInputPart = typeof PluginInputPart.Type;
