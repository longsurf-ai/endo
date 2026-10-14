// Purpose: Defines the public actions and ephemeral state of native provider setup.
import { Schema } from "effect";

/** Public onboarding actions; startup also installs missing managed runtimes. */
export const SetupAction = Schema.Literals(["login", "install"]);
/** A native onboarding action. */
export type SetupAction = typeof SetupAction.Type;

/** In-memory output is bounded and never saved to settings, events, or logs. */
export const SetupState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({
    status: Schema.Literals(["running", "succeeded", "failed", "cancelled"]),
    id: Schema.String,
    action: SetupAction,
    output: Schema.String,
  }),
]);
/** Public setup state inferred from its owning schema. */
export type SetupState = typeof SetupState.Type;
