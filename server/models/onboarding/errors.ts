// Purpose: Reports unavailable or failed provider onboarding actions.
import { Schema } from "effect";

/** An onboarding action is stale, already running, or failed to start or complete. */
export class SetupFailed extends Schema.TaggedError<SetupFailed>()(
  "Models.SetupFailed",
  { message: Schema.String },
) {}
