// Purpose: Keep config failures explicit without exposing file contents or secrets.
import { Schema } from "effect";

/** The authoritative settings file could not be read or parsed. */
export class ConfigReadFailed extends Schema.TaggedError<ConfigReadFailed>()(
  "ConfigReadFailed",
  { cause: Schema.Defect() },
) {}

/** A validated change could not replace the settings file. */
export class ConfigWriteFailed extends Schema.TaggedError<ConfigWriteFailed>()(
  "ConfigWriteFailed",
  { cause: Schema.Defect() },
) {}

/** A public configuration field failed its owning domain's schema. */
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()(
  "ConfigInvalid",
  { cause: Schema.Defect() },
) {}

/** An injected native provider has no editable settings file. */
export class ConfigReadOnly extends Schema.TaggedError<ConfigReadOnly>()(
  "ConfigReadOnly",
  {},
) {}
