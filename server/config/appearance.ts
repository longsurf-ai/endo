// Purpose: Declare appearance preferences once for public config and runtime consumers.
import { Effect, Schema } from "effect";

/** Saved preference; actual system light/dark state is derived by the renderer. */
export const AppearanceSettings = Schema.Struct({
  theme: Schema.Literals(["light", "dark", "system"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("system")),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({})));
