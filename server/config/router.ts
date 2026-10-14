// Purpose: Compose domain schemas into the public Config read and merge-patch boundary.
import { Config, Effect, Schema, Struct } from "effect";
import { ModelsSettings } from "@openchart/server/models/config";
import { NotificationSettings } from "@openchart/server/notification/config";
import { trpc } from "@openchart/server/lib/trpc";
import { AppearanceSettings } from "./appearance";
import { ConfigInvalid, ConfigReadFailed } from "./errors";
import { ConfigFile } from "./provider";
import { mergePatchSchema } from "./merge-patch";

/** The public domain inventory; defaults and field constraints come from each owner. */
export const Settings = Schema.Struct({
  appearance: AppearanceSettings,
  notifications: NotificationSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  models: ModelsSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

const patchSchema = mergePatchSchema(Settings);

/**
 * Reads the file-backed config, including defaults, and commits validated patches.
 * Unknown file namespaces are preserved but never exposed or writable here.
 * @example await client.config.update.mutate({appearance: {theme: 'dark'}});
 */
export const configRouter = trpc.router({
  get: trpc.procedure.query(({ ctx }) =>
    ctx.runtime.runPromise(
      ConfigFile.use((file) =>
        file.read.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Settings)),
          // Explicitly injected native providers support reads, but have no writable file.
          Effect.catchTag("ConfigReadOnly", () => Config.schema(Settings)),
          Effect.mapError((cause) => new ConfigReadFailed({ cause })),
        ),
      ),
    ),
  ),
  update: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(patchSchema, {
        parseOptions: { onExcessProperty: "error" },
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        ConfigFile.use((file) =>
          file.update(input, (merged) =>
            // Keep key-level defaults inside their enclosing object when a patch
            // deletes an entire domain. Validate only the affected domains.
            Schema.decodeUnknownEffect(
              Schema.Struct(
                Struct.pick(
                  Settings.fields,
                  Object.keys(input) as Array<keyof typeof Settings.fields>,
                ),
              ),
            )(merged).pipe(
              Effect.mapError((cause) => new ConfigInvalid({ cause })),
            ),
          ),
        ),
      ),
    ),
});
