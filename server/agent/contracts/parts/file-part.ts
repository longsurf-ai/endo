// Purpose: Owns file transcript Parts and their source references.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";

const FilePartSourceBase = Schema.Struct({
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Finite.check(Schema.isInt()),
    end: Schema.Finite.check(Schema.isInt()),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } })
    .annotate({
      identifier: "FilePartSourceText",
    }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } });

/** Canonical file source schema for agent transcript content. */
export const FileSource = Schema.Struct({
  ...FilePartSourceBase.fields,
  type: Schema.Literal("file"),
  path: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "FileSource",
  });

/** Canonical file part source schema for agent transcript content. */
export const FilePartSource = Schema.Union([FileSource]).annotate({
  identifier: "FilePartSource",
});

/** Canonical file part schema for agent transcript content. */
export const FilePart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "FilePart",
  });
/** Parsed file part value. */
export type FilePart = typeof FilePart.Type;
