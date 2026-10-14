// Purpose: Owns plugin input activation and attributed hook failures.

import { Schema } from "effect";

/** An input has no registered preparation owner in the selected profile. */
export class UnhandledInput extends Schema.TaggedError<UnhandledInput>()(
  "AgentPlugin.UnhandledInput",
  { agent: Schema.String, input: Schema.String },
) {}

/** Expected plugin failure with invocation and hook attribution. */
export class HookFailed extends Schema.TaggedError<HookFailed>()(
  "AgentPlugin.HookFailed",
  {
    pluginID: Schema.String,
    hook: Schema.String,
    runID: Schema.String,
    triggerMessageID: Schema.String,
    cause: Schema.Defect(),
  },
) {}
