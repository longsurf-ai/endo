// Purpose: Exposes the model service and wires configuration, setup, and registry lifetimes.

export * as Models from "./models";

import { createInstallations } from "./onboarding/installation";
import { isDeepStrictEqual } from "node:util";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { ModelsDev } from "@openchart/models/catalog";
import type {
  AvailableModel,
  AvailableProvider,
  ProviderDiscoveryResult,
} from "@openchart/models/model-provider";
import type { ProviderQuota } from "@openchart/models/provider-quota";
import {
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  ScopedRef,
  Stream,
  Semaphore,
} from "effect";
import { ConfigProviderUpdates } from "@openchart/server/config/provider";
import { Events } from "@openchart/server/events";

import {
  ConfigurationUnavailable,
  type ModelError,
  type QuotaUnavailable,
} from "./errors";
import { config } from "./config";
import type { NativeProviderID } from "@openchart/models/model-tiers";
import { NodeServices } from "@effect/platform-node";
import { makeProviderSetup, type ProviderSetup } from "./onboarding/onboarding";
import { Event } from "./events";
import { createRegistry } from "./model-registry";

/** Model discovery and SDK lookup through the currently configured registry. */
export interface Interface {
  /** Checks a native provider regardless of enablement; never starts setup.
   * @example const state = yield* models.discover(CODEX);
   */
  readonly discover: (
    providerID: NativeProviderID,
  ) => Effect.Effect<ProviderDiscoveryResult, ModelError>;

  /** Reads a native provider's current plan quota regardless of enablement.
   * Never cached and never used by discovery, the model list, or model resolution,
   * so every call reads native state again. Failed native reads become
   * {@link QuotaUnavailable}; they never make the provider unavailable.
   * @example const quota = yield* models.quota(CODEX);
   */
  readonly quota: (
    providerID: NativeProviderID,
  ) => Effect.Effect<ProviderQuota, QuotaUnavailable | ModelError>;

  /** Recreates managed native clients and invalidates model/account discovery.
   * @example yield* models.refresh();
   */
  readonly refresh: () => Effect.Effect<void, ModelError>;

  /** Scope-owned, installation and login operations. */
  readonly setup: ProviderSetup;

  /**
   * Lists product-supported providers available in the current environment,
   * together with their models and available variants.
   * Calls share each provider's successful discovery for one hour per registry
   * instance. Concurrent calls share in-flight discovery.
   *
   * A provider whose discovery fails is omitted and retried on the next call, so
   * it never hides the others; {@link Interface.discover} and
   * {@link Interface.getModel} still report its failure. Provider IDs are unique.
   *
   * @example
   * ```ts
   * const models = yield* Models.Service;
   * const providers = yield* models.list();
   * ```
   */
  readonly list: () => Effect.Effect<readonly AvailableProvider[], ModelError>;

  /**
   * Resolves an enabled provider's current native model metadata without using the list cache.
   * Exact SDK IDs match verbatim; tiers fall downward within that provider.
   * Missing selections fail with ModelNotFound; discovery failures retain provider and cause.
   *
   * @example
   * ```ts
   * const model = yield* models.getModel(CODEX, 'gpt-5.6-luna');
   * ```
   */
  readonly getModel: (
    providerID: string,
    modelID: string,
  ) => Effect.Effect<AvailableModel, ModelError>;

  /**
   * Gets an AI SDK model handle without starting a model request.
   *
   * Callers own request cancellation and consume the models package's unchanged
   * protocol normalization. No agent loop or second streaming protocol lives here.
   * The handle belongs to the current provider and may become unusable when
   * configuration changes dispose that provider.
   *
   * @example
   * ```ts
   * const language = yield* models.getLanguage(model);
   * const result = streamText({model: language, prompt: 'Hello'});
   * ```
   */
  readonly getLanguage: (
    model: AvailableModel,
  ) => Effect.Effect<LanguageModelV4, ModelError>;
}

/**
 * Model service; configuration changes replace its registry and dispose the old one.
 * Active requests may fail when their provider is replaced.
 *
 * @example
 * ```ts
 * const models = yield* Models.Service;
 * const model = yield* models.getModel(CODEX, 'gpt-5.6-luna');
 * ```
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Models",
) {}

/** Host-owned catalog settings and persistent runtime storage, separate from disposable catalog caches. */
export interface Options extends ModelsDev.Options {
  readonly runtimeDirectory: string;
  /** Desktop enables background installation when its backend starts. */
  readonly installOnStartup?: boolean;
}

/**
 * Owns a lazy catalog and the current registry. Provider configuration or explicit refresh
 * requests replace and dispose the registry without waiting for callers.
 * Default-model changes do not rebuild SDKs. Construction performs no discovery;
 * desktop may opt into background installation of missing runtimes.
 * @example
 * const models = Models.layer({cacheDirectory: '/tmp/models', runtimeDirectory: '/tmp/model-providers', fetchEnabled: false, userAgent: 'OpenChart/V2'});
 * const llmLayer = LLM.layer.pipe(Layer.provide(models));
 */
export function layer(options: Options) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const source = yield* ConfigProvider.ConfigProvider;
      const updates = (yield* ConfigProviderUpdates)(source);
      const events = yield* Events.Service;
      const catalog = ModelsDev.create(options);
      const installations = createInstallations(options.runtimeDirectory);
      const readProviderSettings = (provider: ConfigProvider.ConfigProvider) =>
        config.parse(provider).pipe(
          Effect.map((settings) => settings.providers),
          Effect.mapError((cause) => new ConfigurationUnavailable({ cause })),
          Effect.exit,
        );
      let currentSettings = yield* readProviderSettings(source);
      const acquireRegistry = Effect.suspend(() =>
        Effect.flatMap(currentSettings, (settings) =>
          createRegistry(catalog, settings, installations.executables),
        ),
      ).pipe(Effect.exit);
      const registryRef = yield* ScopedRef.fromAcquire(acquireRegistry);
      const replacementGate = Semaphore.makeUnsafe(1);
      const refreshAll = () =>
        replacementGate.withPermit(
          Effect.gen(function* () {
            yield* ScopedRef.set(registryRef, acquireRegistry);
            yield* events.publish(Event.Changed, {});
          }),
        );
      yield* updates.pipe(
        Stream.runForEach((provider) =>
          replacementGate.withPermit(
            Effect.gen(function* () {
              const next = yield* readProviderSettings(provider);
              if (
                Exit.isSuccess(currentSettings) && Exit.isSuccess(next)
                  ? isDeepStrictEqual(currentSettings.value, next.value)
                  : Exit.isFailure(currentSettings) && Exit.isFailure(next)
              )
                return;
              currentSettings = next;
              yield* ScopedRef.set(registryRef, acquireRegistry);
              yield* events.publish(Event.Changed, {});
            }).pipe(Effect.uninterruptible),
          ),
        ),
        Effect.forkScoped,
      );
      const currentRegistry = Effect.flatten(ScopedRef.get(registryRef));
      const inspectCurrent = <A, E>(
        read: (
          current: Effect.Success<typeof currentRegistry>,
        ) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          // Retry only read-only inspection when settings/refresh replace its client.
          // Never replay inference or setup actions.
          while (true) {
            const selected = yield* replacementGate.withPermit(currentRegistry);
            const result = yield* Effect.exit(read(selected));
            if (
              (yield* replacementGate.withPermit(currentRegistry)) === selected
            )
              return yield* result;
          }
        });
      const discover = (providerID: NativeProviderID) =>
        inspectCurrent((current) => current.discover(providerID));
      const setup = yield* makeProviderSetup(
        discover,
        (providerID) =>
          Effect.gen(function* () {
            yield* replacementGate.withPermit(
              Effect.flatMap(currentRegistry, (current) =>
                current.refreshProvider(providerID),
              ),
            );
            // Recheck auth after both install and login; native credentials remain authoritative.
            yield* discover(providerID);
          }),
        installations,
        events.publish(Event.Changed, {}),
        options.installOnStartup,
      );
      return Service.of({
        discover,
        quota: (providerID) =>
          inspectCurrent((current) => current.quota(providerID)),
        refresh: refreshAll,
        setup,
        list: () => inspectCurrent((current) => current.list()),
        getModel: (providerID, modelID) =>
          Effect.flatMap(currentRegistry, (current) =>
            current.getModel(providerID, modelID),
          ),
        getLanguage: (model) =>
          Effect.flatMap(currentRegistry, (current) =>
            current.getLanguage(model),
          ),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}
