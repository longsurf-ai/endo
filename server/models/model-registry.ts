// Purpose: Composes native bindings, discovery, and model lookup for one scoped settings snapshot.
import { NoSuchModelError } from "ai";
import { ModelsDev } from "@openchart/models/catalog";
import type {
  AvailableModel,
  ModelProvider,
} from "@openchart/models/model-provider";
import {
  MODEL_PROVIDER_IDS,
  ModelTier,
  resolveModelTier,
  type NativeProviderID,
} from "@openchart/models/model-tiers";
import { NATIVE_PROVIDERS } from "@openchart/models/providers";
import { assertTrue } from "@openchart/utils/assert";
import { Cache, Effect, Exit, Option } from "effect";
import { ModelsSettings } from "./config";
import { ModelNotFound, ProviderInit, QuotaUnavailable } from "./errors";

export const createRegistry = Effect.fn("Models.createRegistry")(function* (
  catalog: ReturnType<typeof ModelsDev.create>,
  settings: typeof ModelsSettings.Type.providers,
  executables: Readonly<Record<NativeProviderID, string>>,
) {
  const scope = yield* Effect.scope;
  const assertActive = () =>
    assertTrue(scope.state._tag !== "Closed", "Model providers are disposed");
  const bindings = new Map<NativeProviderID, ModelProvider>();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      const results = await Promise.allSettled(
        [...bindings.values()].map(async (binding) => binding.dispose()),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "Failed to dispose model providers");
    }),
  );
  const createBinding = (id: NativeProviderID) => {
    const binding = NATIVE_PROVIDERS[id].createModelProvider(
      catalog,
      executables[id],
    );
    bindings.set(id, binding);
    assertTrue(binding.id === id, `Binding provider ID does not match: ${id}`);
  };
  for (const id of MODEL_PROVIDER_IDS) createBinding(id);
  const enabled = MODEL_PROVIDER_IDS.filter((id) => settings[id].enabled);
  const requireEnabled = Effect.fn("Models.requireEnabled")(function* (
    providerID: string,
    modelID: string,
  ) {
    assertActive();
    const id = enabled.find((id) => id === providerID);
    if (!id)
      return yield* new ModelNotFound({
        providerID,
        modelID,
        cause: new Error("Provider is unavailable or disabled"),
      });
    return id;
  });
  const discover = Effect.fn("Models.discover")(function* (
    providerID: NativeProviderID,
  ) {
    assertActive();
    const binding = bindings.get(providerID)!;
    const result = yield* Effect.tryPromise({
      try: () => binding.discover(),
      catch: (cause) => new ProviderInit({ providerID, cause }),
    }).pipe(Effect.ensuring(Effect.sync(assertActive)));
    assertTrue(
      result.status !== "ready" || result.provider.id === providerID,
      `Discovery provider ID does not match binding: ${providerID}`,
    );
    return result;
  });
  const quota = Effect.fn("Models.quota")(function* (
    providerID: NativeProviderID,
  ) {
    assertActive();
    const binding = bindings.get(providerID)!;
    return yield* Effect.tryPromise({
      try: () => binding.readQuota(),
      catch: (cause) => new QuotaUnavailable({ providerID, cause }),
    }).pipe(Effect.ensuring(Effect.sync(assertActive)));
  });
  // One entry per provider, so a failure omits and retries only that provider.
  const discovery = yield* Cache.makeWith(discover, {
    capacity: MODEL_PROVIDER_IDS.length,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 hour" : 0),
  });
  return {
    refreshProvider: Effect.fn("Models.refreshProvider")(function* (
      providerID: NativeProviderID,
    ) {
      assertActive();
      yield* Effect.promise(() => bindings.get(providerID)!.dispose());
      assertActive();
      createBinding(providerID);
      yield* Cache.invalidate(discovery, providerID);
    }, Effect.uninterruptible),
    discover,
    quota,
    list: Effect.fn("Models.list")(function* () {
      const results = yield* Effect.forEach(
        enabled,
        (id) => Effect.option(Cache.get(discovery, id)),
        { concurrency: "unbounded" },
      );
      return results.flatMap((result) =>
        Option.isSome(result) && result.value.status === "ready"
          ? [result.value.provider]
          : [],
      );
    }),
    getModel: Effect.fn("Models.getModel")(function* (
      providerID: string,
      modelID: string,
    ) {
      const id = yield* requireEnabled(providerID, modelID);
      const result = yield* discover(id);
      const models = result.status === "ready" ? result.provider.models : [];
      const tier = ModelTier.safeParse(modelID);
      const model = tier.success
        ? resolveModelTier(providerID, tier.data, models)
        : models.find(
            (model) => model.kind === "language" && model.id === modelID,
          );
      if (!model)
        return yield* new ModelNotFound({
          providerID,
          modelID,
          cause: new Error("Model is unavailable"),
        });
      return model;
    }),
    getLanguage: Effect.fn("Models.getLanguage")(function* (
      model: AvailableModel,
    ) {
      const id = yield* requireEnabled(model.providerID, model.id);
      const binding = bindings.get(id)!;
      const sdk = yield* Effect.try({
        try: () => binding.sdk,
        catch: (cause) =>
          new ProviderInit({ providerID: model.providerID, cause }),
      });
      return yield* Effect.try({
        try: () => sdk.languageModel(model.id),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          NoSuchModelError.isInstance(cause)
            ? Effect.fail(
                new ModelNotFound({
                  providerID: model.providerID,
                  modelID: model.id,
                  cause,
                }),
              )
            : Effect.die(cause),
        ),
      );
    }),
  };
});
