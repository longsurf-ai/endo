// Purpose: Declares native provider activation, permission preference, and default selection.
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  MODEL_PROVIDER_IDS,
} from "@openchart/models/model-tiers";
import { PROVIDER_PERMISSION_MODES } from "@openchart/models/provider-permission";
import { Config, Effect, Schema } from "effect";
import { AgentPromptModel } from "@openchart/server/agent/contracts/agent-prompt-input";

/** Native provider IDs accepted by setup actions and configuration. */
export const NativeProviderID = Schema.Literals(MODEL_PROVIDER_IDS);

const NativeProviderSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
});

/** Public model configuration; native agents keep their own authentication. */
export const ModelsSettings = Schema.Struct({
  /** Cross-provider policy captured at the start of each native request. */
  permissionMode: Schema.Literals(PROVIDER_PERMISSION_MODES).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("full-access")),
  ),
  providers: Schema.Struct({
    [CODEX]: NativeProviderSettings.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    [CLAUDE_CODE]: NativeProviderSettings.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    [ANTIGRAVITY]: NativeProviderSettings.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  defaultModel: Schema.optionalKey(AgentPromptModel),
});

/** Reads the domain schema from the current native ConfigProvider. */
export const config = Config.schema(
  Schema.Struct({
    models: ModelsSettings.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
  }),
).pipe(Config.map((value) => value.models));
