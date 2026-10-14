// Purpose: Owns workflow intent Parts and their public argument contract.

import { Schema, SchemaGetter, Struct } from "effect";
import { PartBase } from "./part-base";

// @agent invariant: Public workflow arguments are always an object and cannot
// claim the runtime-owned context key. Workflow definitions refine this
// generic envelope with their product-specific schemas.
/** Canonical workflow public args schema for agent transcript content. */
export const WorkflowPublicArgs = Schema.JsonObject.check(
  Schema.makeFilter((args) => !Object.hasOwn(args, "context"), {
    message:
      "Workflow arguments cannot provide the runtime-owned context field",
  }),
).annotate({ identifier: "WorkflowPublicArgs" });

/** File reference in the current or default workspace; catalog IDs are not supported. */
export const WorkflowId = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => value.trim()),
    encode: SchemaGetter.passthrough(),
  }),
)
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(4096))
  .check(
    Schema.makeFilter(
      (value) =>
        /^(workspace|default):[^\\\\:\0]+\.workflow\.ts$/.test(value) &&
        value
          .slice(value.indexOf(":") + 1)
          .split("/")
          .every((part) => part.length > 0 && !part.startsWith(".")),
      {
        message:
          "Expected workspace:relative/path.workflow.ts or default:relative/path.workflow.ts",
      },
    ),
  );
/** Parsed workflow id value. */
export type WorkflowId = typeof WorkflowId.Type;

// WorkflowPart is persisted user control intent, never rewritten into prompt
// text or a feature-specific queue payload. Prompt owns execution progress
// through the surrounding Assistant lifecycle, not a field on this Part.
/** Canonical workflow part schema for agent transcript content. */
export const WorkflowPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("workflow"),
  workflow: WorkflowId,
  args: WorkflowPublicArgs,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "WorkflowPart",
  });
/** Parsed workflow part value. */
export type WorkflowPart = typeof WorkflowPart.Type;
