// Purpose: Defines expected failures owned by prompt preparation and execution.

import { Schema } from "effect";

/** Expected prompt execution failure; Runner may continue with later queued runs. */
export class Failed extends Schema.TaggedError<Failed>()("Prompt.Failed", {
  cause: Schema.Defect(),
}) {}

/** An accepted prompt names a profile that is no longer registered. */
export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound>()(
  "Prompt.ProfileNotFound",
  { name: Schema.String },
) {}

/** Input requires a feature runtime that has not been migrated into V2. */
export class UnsupportedInput extends Schema.TaggedError<UnsupportedInput>()(
  "Prompt.UnsupportedInput",
  { type: Schema.String, detail: Schema.String },
) {}
