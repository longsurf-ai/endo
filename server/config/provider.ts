// Purpose: Own atomic settings.json writes, file observation, and native config snapshots.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { Events } from "@openchart/server/events";
import {
  ConfigInvalid,
  ConfigReadFailed,
  ConfigReadOnly,
  ConfigWriteFailed,
} from "./errors";
import { ConfigChanged } from "./events";
import { mergePatch } from "./merge-patch";

/**
 * Supplies immutable snapshots only for the matching native source.
 * Static providers have no updates. The source scope owns observation.
 * @example const updates = (yield* ConfigProviderUpdates)(provider);
 */
export const ConfigProviderUpdates = Context.Reference<
  (
    provider: ConfigProvider.ConfigProvider,
  ) => Stream.Stream<ConfigProvider.ConfigProvider>
>("@openchart/server/config/ConfigProviderUpdates", {
  defaultValue: () => () => Stream.empty,
});

/**
 * File access owned by the backend runtime. Domains validate their merged fields.
 * Native consumers continue using ConfigProvider, not this file capability.
 * @example yield* ConfigFile.use(file => file.read);
 */
export class ConfigFile extends Context.Service<
  ConfigFile,
  {
    readonly read: Effect.Effect<
      Schema.JsonObject,
      ConfigReadFailed | ConfigReadOnly
    >;
    readonly update: (
      patch: Schema.JsonObject,
      validate: (
        merged: Schema.JsonObject,
      ) => Effect.Effect<unknown, ConfigInvalid>,
    ) => Effect.Effect<
      void,
      ConfigReadFailed | ConfigWriteFailed | ConfigInvalid | ConfigReadOnly
    >;
  }
>()("@openchart/server/config/ConfigFile") {}

function containsNull(value: Schema.Json): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  return typeof value === "object" && Object.values(value).some(containsNull);
}

const Document = Schema.fromJsonString(
  Schema.JsonObject.check(
    Schema.makeFilter((value) => !containsNull(value), {
      message: "Config cannot contain null; omit a key to use its default",
    }),
  ),
);

const decode = (text: string | undefined) =>
  Schema.decodeUnknownEffect(Document)(text ?? "{}").pipe(
    Effect.mapError((cause) => new ConfigReadFailed({ cause })),
  );

type Snapshot = {
  readonly provider: ConfigProvider.ConfigProvider;
  readonly read: Effect.Effect<Schema.JsonObject, ConfigReadFailed>;
};

function snapshot(document: Schema.JsonObject): Snapshot {
  return {
    provider: ConfigProvider.fromUnknown(document, {
      preserveEmptyStrings: true,
    }),
    read: Effect.succeed(document),
  };
}

/**
 * Monitors a single file and serializes read/merge/validate/atomic-replace writes.
 * Missing files permit defaults; malformed startup content fails construction.
 * Invalid reloads invalidate readers until corrected. No directory is created
 * until a write. Scope disposal stops polling; acknowledged writes are on disk.
 * @example const runtime = ManagedRuntime.make(layerFromFile(filename).pipe(Layer.provide(Events.layer)));
 */
export function layerFromFile(filename: string) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const events = yield* Events.Service;
      const mutex = yield* Semaphore.make(1);
      const read = Effect.tryPromise({
        try: (signal) =>
          readFile(filename, { encoding: "utf8", signal }).catch(
            (cause: NodeJS.ErrnoException) => {
              if (cause.code === "ENOENT") return undefined;
              throw cause;
            },
          ),
        catch: (cause) => new ConfigReadFailed({ cause }),
      });
      let previous = yield* read;
      const current = yield* SubscriptionRef.make(
        snapshot(yield* decode(previous)),
      );
      let failed = false;

      const ingest = Effect.fn("ConfigFile.ingest")(function* (
        text: string | undefined,
        document: Schema.JsonObject,
      ) {
        if (!failed && text === previous) return;
        previous = text;
        failed = false;
        yield* SubscriptionRef.set(current, snapshot(document));
        yield* events.publish(ConfigChanged, {});
      });
      const unavailable = Effect.fn("ConfigFile.unavailable")(function* (
        error: ConfigReadFailed,
      ) {
        if (failed) return;
        failed = true;
        yield* SubscriptionRef.set(current, {
          read: Effect.fail(error),
          provider: ConfigProvider.make(() =>
            Effect.fail(
              new ConfigProvider.SourceError({
                message: "Unable to read settings.json",
                cause: error,
              }),
            ),
          ),
        });
        yield* events.publish(ConfigChanged, {});
        yield* Effect.logError(
          "Unable to read settings.json; fix the file to resume config updates",
        );
      });
      const refresh = mutex.withPermits(1)(
        Effect.gen(function* () {
          const text = yield* read;
          if (!failed && text === previous) return;
          yield* ingest(text, yield* decode(text));
        }).pipe(Effect.catchTag("ConfigReadFailed", unavailable)),
      );
      yield* refresh.pipe(
        Effect.repeat(Schedule.spaced("250 millis")),
        Effect.forkScoped,
      );

      const update = Effect.fn("ConfigFile.update")(
        (
          patch: Schema.JsonObject,
          validate: (
            merged: Schema.JsonObject,
          ) => Effect.Effect<unknown, ConfigInvalid>,
        ) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const text = yield* read;
              const before = yield* decode(text);
              const merged = mergePatch(before, patch);
              yield* validate(merged);
              if (JSON.stringify(before) === JSON.stringify(merged)) {
                yield* ingest(text, before);
                return;
              }
              const serialized = `${JSON.stringify(merged, null, 2)}\n`;
              // The temporary file stays beside its destination so rename is atomic.
              const temporary = join(
                dirname(filename),
                `.${basename(filename)}.${randomUUID()}.tmp`,
              );
              yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(dirname(filename), { recursive: true });
                  try {
                    await writeFile(temporary, serialized, {
                      encoding: "utf8",
                      mode: 0o600,
                      flag: "wx",
                    });
                    await rename(temporary, filename);
                  } catch (cause) {
                    await rm(temporary, { force: true }).catch(() => undefined);
                    throw cause;
                  }
                },
                catch: (cause) => new ConfigWriteFailed({ cause }),
              });
              yield* ingest(serialized, merged);
            }).pipe(
              Effect.catchTag("ConfigReadFailed", (error) =>
                unavailable(error).pipe(Effect.andThen(Effect.fail(error))),
              ),
              // Once admitted, finish a committed write and publication even if its caller disconnects.
              Effect.uninterruptible,
            ),
          ),
      );

      const provider = ConfigProvider.make((path) =>
        Effect.flatMap(SubscriptionRef.get(current), (value) =>
          value.provider.load(path),
        ),
      );
      return Layer.mergeAll(
        ConfigProvider.layer(provider),
        Layer.succeed(ConfigFile, {
          read: Effect.flatMap(
            SubscriptionRef.get(current),
            (value) => value.read,
          ),
          update,
        }),
        Layer.succeed(ConfigProviderUpdates, (source) =>
          source === provider
            ? SubscriptionRef.changes(current).pipe(
                Stream.map((value) => value.provider),
              )
            : Stream.empty,
        ),
      );
    }),
  );
}

/**
 * An explicitly injected provider has no editable file; runtime config reads work
 * normally, while file management fails explicitly instead of writing an unrelated path.
 * @example const configured = layerFromProvider(ConfigProvider.fromUnknown({}));
 */
export function layerFromProvider(provider: ConfigProvider.ConfigProvider) {
  return Layer.merge(
    ConfigProvider.layer(provider),
    Layer.succeed(ConfigFile, {
      read: Effect.fail(new ConfigReadOnly({})),
      update: () => Effect.fail(new ConfigReadOnly({})),
    }),
  );
}
