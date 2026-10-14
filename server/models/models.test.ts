// Purpose: Verifies native discovery, selection, refresh, and scope-owned binding lifetimes.
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  TIER1,
  TIER4,
  classifyModels,
} from "@openchart/models/model-tiers";
import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import { NoSuchModelError } from "ai";
import { ModelsDev } from "@openchart/models/catalog";
import { NATIVE_PROVIDERS } from "@openchart/models/providers";
import { claudeCodeTiers } from "@openchart/models/providers/claude-code/tiers";
import {
  AvailableModel,
  type ModelProvider,
} from "@openchart/models/model-provider";
import { ConfigProviderUpdates } from "@openchart/server/config/provider";
import { Events } from "@openchart/server/events";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test, vi } from "vitest";
import {
  ModelNotFound,
  type ModelError,
  type QuotaUnavailable,
} from "./errors";
import { Models } from "./models";
import { modelTestDependencies } from "./models.test-utils";
import { ModelsSettings } from "./config";

const options: Models.Options = {
  runtimeDirectory: "/unused/providers",
  cacheDirectory: "/unused/models",
  fetchEnabled: false,
  userAgent: "test",
};
const model = AvailableModel.parse({
  kind: "language",
  providerID: CODEX,
  id: "gpt-5.6-luna",
  name: "Luna",
  capabilities: { input: {}, output: {} },
});

function binding(
  id: string,
  models: AvailableModel[] = [{ ...model, providerID: id }],
) {
  const language: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: id,
    modelId: model.id,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
  const sdk: ProviderV4 = {
    specificationVersion: "v4",
    languageModel: vi.fn(() => language),
    embeddingModel: vi.fn(),
    imageModel: vi.fn(),
  };
  const readSDK = vi.fn(() => sdk);
  const provider = { id, name: id, models };
  const native = {
    id,
    discover: vi.fn<ModelProvider["discover"]>(async () => ({
      status: "ready",
      provider,
    })),
    readQuota: vi.fn<ModelProvider["readQuota"]>(async () => ({
      status: "not_applicable",
    })),
    get sdk() {
      return readSDK();
    },
    dispose: vi.fn(async () => {}),
  } satisfies ModelProvider;
  return { native, provider, sdk, language, readSDK };
}

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
});

function fixture(initial: unknown = {}) {
  const codex = binding(CODEX, [model]);
  const claude = binding(CLAUDE_CODE);
  claude.native.discover.mockResolvedValue({ status: "not_installed" });
  const createCodex = vi
    .spyOn(NATIVE_PROVIDERS[CODEX], "createModelProvider")
    .mockReturnValue(codex.native);
  const createClaude = vi
    .spyOn(NATIVE_PROVIDERS[CLAUDE_CODE], "createModelProvider")
    .mockReturnValue(claude.native);
  const catalog = { get: vi.fn(async () => ({})) };
  vi.spyOn(ModelsDev, "create").mockReturnValue(catalog);
  const snapshots = Effect.runSync(
    SubscriptionRef.make(ConfigProvider.fromUnknown(initial)),
  );
  const source = ConfigProvider.make((path) =>
    Effect.flatMap(SubscriptionRef.get(snapshots), (snapshot) =>
      snapshot.load(path),
    ),
  );
  const runtime = ManagedRuntime.make(
    Models.layer(options).pipe(
      Layer.provideMerge(modelTestDependencies),
      Layer.provide(ConfigProvider.layer(source)),
      Layer.provide(
        Layer.succeed(ConfigProviderUpdates, () =>
          SubscriptionRef.changes(snapshots),
        ),
      ),
    ),
  );
  runtimes.push(runtime);
  const update = (settings: unknown) =>
    runtime.runPromise(
      SubscriptionRef.set(snapshots, ConfigProvider.fromUnknown(settings)),
    );
  return { runtime, codex, claude, createCodex, createClaude, catalog, update };
}

test("constructs both bindings lazily without discovery and borrows the SDK without inference", async () => {
  const f = fixture();
  expect(f.createCodex).not.toHaveBeenCalled();
  const service = await f.runtime.runPromise(Models.Service);
  for (const [create, id] of [
    [f.createCodex, CODEX],
    [f.createClaude, CLAUDE_CODE],
  ] as const) {
    expect(create).toHaveBeenCalledExactlyOnceWith(
      f.catalog,
      expect.stringContaining(`/unused/providers/${id}/`),
    );
  }
  for (let i = 0; i < 2; i++) {
    expect(await f.runtime.runPromise(service.getLanguage(model))).toBe(
      f.codex.language,
    );
  }
  expect(f.codex.sdk.languageModel).toHaveBeenCalledWith(model.id);
  expect(f.codex.native.discover).not.toHaveBeenCalled();
  expect(f.claude.native.discover).not.toHaveBeenCalled();
  expect(f.catalog.get).not.toHaveBeenCalled();
  expect(f.codex.language.doStream).not.toHaveBeenCalled();
  expect(f.codex.native.dispose).not.toHaveBeenCalled();
  await f.runtime.dispose();
  await f.runtime.dispose();
  expect(f.codex.native.dispose).toHaveBeenCalledOnce();
  expect(f.claude.native.dispose).toHaveBeenCalledOnce();
});

test("discovers concurrently in registration order, preserving native metadata", async () => {
  const f = fixture();
  let finish!: (value: Awaited<ReturnType<ModelProvider["discover"]>>) => void;
  f.codex.native.discover.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.claude.native.discover.mockResolvedValue({
    status: "ready",
    provider: f.claude.provider,
  });
  const service = await f.runtime.runPromise(Models.Service);
  const pending = f.runtime.runPromise(service.list());
  await vi.waitFor(() =>
    expect(f.claude.native.discover).toHaveBeenCalledOnce(),
  );
  expect(f.codex.native.discover).toHaveBeenCalledOnce();
  finish({ status: "ready", provider: f.codex.provider });
  const providers = await pending;
  expect(providers).toEqual([f.codex.provider, f.claude.provider]);
  expect(providers[0]).toBe(f.codex.provider);
  expect(providers[1]).toBe(f.claude.provider);
  expect(f.codex.readSDK).not.toHaveBeenCalled();
});

test("omits setup requirements while retaining a ready provider with no models", async () => {
  const f = fixture();
  f.codex.native.discover.mockResolvedValue({
    status: "authentication_required",
    login: { executable: "/codex", args: ["login"] },
  });
  f.claude.native.discover.mockResolvedValue({
    status: "ready",
    provider: { ...f.claude.provider, models: [] },
  });
  const service = await f.runtime.runPromise(Models.Service);
  expect(await f.runtime.runPromise(service.list())).toEqual([
    { ...f.claude.provider, models: [] },
  ]);
});

test("shares concurrent list discovery and caches success for one hour", async () => {
  const f = fixture();
  await f.runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* Models.Service;
      const [first, concurrent] = yield* Effect.all(
        [service.list(), service.list()],
        { concurrency: "unbounded" },
      );
      expect(concurrent).toEqual(first);
      expect(f.codex.native.discover).toHaveBeenCalledOnce();
      yield* TestClock.adjust("59 minutes");
      expect(yield* service.list()).toEqual(first);
      expect(f.codex.native.discover).toHaveBeenCalledOnce();
      yield* TestClock.adjust("1 minute");
      f.codex.native.discover.mockResolvedValueOnce({
        status: "not_installed",
      });
      expect(yield* service.list()).toEqual([]);
      expect(yield* service.list()).toEqual([]);
      expect(f.codex.native.discover).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test.each([CODEX, CLAUDE_CODE])(
  "%s discovery failures omit only that provider, share in-flight work, and retry immediately",
  async (id) => {
    const f = fixture();
    f.claude.native.discover.mockResolvedValue({
      status: "ready",
      provider: f.claude.provider,
    });
    const [failing, healthy] =
      id === CODEX ? [f.codex, f.claude] : [f.claude, f.codex];
    failing.native.discover.mockRejectedValueOnce(
      new Error("native discovery failed"),
    );
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* Models.Service;
        const [first, concurrent] = yield* Effect.all(
          [service.list(), service.list()],
          { concurrency: "unbounded" },
        );
        expect(first).toEqual([healthy.provider]);
        expect(concurrent).toEqual(first);
        expect(failing.native.discover).toHaveBeenCalledOnce();
        expect(yield* service.list()).toEqual([
          f.codex.provider,
          f.claude.provider,
        ]);
        expect(failing.native.discover).toHaveBeenCalledTimes(2);
        expect(healthy.native.discover).toHaveBeenCalledOnce();
      }),
    );
  },
);

test("getModel reads fresh native availability independently of the cached list", async () => {
  const f = fixture();
  const service = await f.runtime.runPromise(Models.Service);
  await f.runtime.runPromise(service.list());
  expect(await f.runtime.runPromise(service.getModel(CODEX, model.id))).toBe(
    model,
  );
  f.codex.native.discover.mockResolvedValueOnce({ status: "not_installed" });
  await expect(
    f.runtime.runPromise(service.getModel(CODEX, model.id)),
  ).rejects.toMatchObject({
    _tag: "Models.NotFound",
    providerID: CODEX,
    modelID: model.id,
  });
  const updated = { ...model, name: "Updated", tier: 4 };
  f.codex.native.discover.mockResolvedValue({
    status: "ready",
    provider: { ...f.codex.provider, models: [updated] },
  });
  expect(await f.runtime.runPromise(service.getModel(CODEX, model.id))).toBe(
    updated,
  );
  expect(f.claude.native.discover).toHaveBeenCalledOnce();
  expect(f.codex.readSDK).not.toHaveBeenCalled();
});

test("resolves provider-local tiers while explicit aliases remain exact and unrelated failures do not interfere", async () => {
  const f = fixture();
  f.codex.native.discover.mockRejectedValue(new Error("unrelated failure"));
  const models = classifyModels(claudeCodeTiers, [
    { ...model, providerID: CLAUDE_CODE, id: "opus" },
    { ...model, providerID: CLAUDE_CODE, id: "opus[1m]" },
  ]);
  f.claude.native.discover.mockResolvedValue({
    status: "ready",
    provider: { ...f.claude.provider, models },
  });
  const service = await f.runtime.runPromise(Models.Service);
  expect(
    (await f.runtime.runPromise(service.getModel(CLAUDE_CODE, TIER4))).id,
  ).toBe("opus[1m]");
  expect(
    await f.runtime.runPromise(service.getModel(CLAUDE_CODE, "opus[1m]")),
  ).toBe(models.find((model) => model.id === "opus[1m]"));
  for (const id of [TIER1, "fable"])
    await expect(
      f.runtime.runPromise(service.getModel(CLAUDE_CODE, id)),
    ).rejects.toBeInstanceOf(ModelNotFound);
  expect(f.codex.native.discover).not.toHaveBeenCalled();
});

test.each(["missing", "toString", "__proto__"])(
  "unknown provider %s fails without touching native clients",
  async (providerID) => {
    const f = fixture();
    const service = await f.runtime.runPromise(Models.Service);
    for (const operation of [
      service.getModel(providerID, model.id),
      service.getLanguage({ ...model, providerID }),
    ]) {
      await expect(
        f.runtime.runPromise<unknown, ModelError>(operation),
      ).rejects.toMatchObject({
        _tag: "Models.NotFound",
        providerID,
        modelID: model.id,
      });
    }
    expect(f.codex.native.discover).not.toHaveBeenCalled();
    expect(f.codex.readSDK).not.toHaveBeenCalled();
  },
);

test("discovery and SDK initialization errors retain provider identity and cause", async () => {
  const f = fixture();
  const cause = new Error("startup");
  const service = await f.runtime.runPromise(Models.Service);
  f.codex.native.discover.mockRejectedValueOnce(cause);
  f.codex.readSDK.mockImplementationOnce(() => {
    throw cause;
  });
  for (const operation of [
    service.getModel(CODEX, model.id),
    service.getLanguage(model),
  ]) {
    await expect(
      f.runtime.runPromise<unknown, ModelError>(operation),
    ).rejects.toMatchObject({
      _tag: "Models.ProviderInit",
      providerID: CODEX,
      cause,
    });
  }
  expect(await f.runtime.runPromise(service.getLanguage(model))).toBe(
    f.codex.language,
  );
});

test.each([false, true])(
  "model factory errors distinguish missing models from defects (missing: %s)",
  async (missing) => {
    const f = fixture();
    const cause = missing
      ? new NoSuchModelError({ modelId: model.id, modelType: "languageModel" })
      : new Error("programming error");
    vi.mocked(f.codex.sdk.languageModel).mockImplementationOnce(() => {
      throw cause;
    });
    const service = await f.runtime.runPromise(Models.Service);
    const exit = await f.runtime.runPromiseExit(service.getLanguage(model));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(Cause.hasDies(exit.cause)).toBe(!missing);
    if (missing) expect(Cause.squash(exit.cause)).toBeInstanceOf(ModelNotFound);
    else expect(Cause.squash(exit.cause)).toBe(cause);
  },
);

test("routes identical native model IDs through their selected SDK", async () => {
  const f = fixture();
  const service = await f.runtime.runPromise(Models.Service);
  const selected = { ...model, providerID: CLAUDE_CODE };
  expect(await f.runtime.runPromise(service.getLanguage(model))).toBe(
    f.codex.language,
  );
  expect(await f.runtime.runPromise(service.getLanguage(selected))).toBe(
    f.claude.language,
  );
  expect(f.claude.sdk.languageModel).toHaveBeenCalledExactlyOnceWith(model.id);
});

test("rejects binding and discovery identities that would route to another provider", async () => {
  const f = fixture();
  f.createClaude.mockReturnValueOnce(binding(CODEX).native);
  const service = await f.runtime.runPromise(Models.Service);
  await expect(f.runtime.runPromise(service.list())).rejects.toThrow(
    "Binding provider ID does not match",
  );
  await f.runtime.dispose();
  expect(f.codex.native.dispose).toHaveBeenCalledOnce();
});

test("rejects mismatched discovery metadata as a defect", async () => {
  const f = fixture();
  f.codex.native.discover.mockResolvedValue({
    status: "ready",
    provider: f.claude.provider,
  });
  const service = await f.runtime.runPromise(Models.Service);
  const exit = await f.runtime.runPromiseExit(service.list());
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
});

test("shutdown awaits every release and retains synchronous and asynchronous cleanup failures", async () => {
  const f = fixture();
  const first = new Error("Codex cleanup");
  const second = new Error("Claude cleanup");
  let finish!: () => void;
  f.codex.native.dispose.mockImplementation(() => {
    throw first;
  });
  f.claude.native.dispose.mockImplementation(
    () =>
      new Promise((_, reject) => {
        finish = () => reject(second);
      }),
  );
  await f.runtime.runPromise(Models.Service);
  let settled = false;
  const disposal = f.runtime.dispose().then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.waitFor(() =>
    expect(f.claude.native.dispose).toHaveBeenCalledOnce(),
  );
  expect(settled).toBe(false);
  finish();
  const error = await disposal;
  runtimes.splice(runtimes.indexOf(f.runtime), 1);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error).toMatchObject({ errors: [first, second] });
  expect(f.codex.native.dispose).toHaveBeenCalledOnce();
});

test("config replacement invalidates in-flight model lookup and leaves default-only changes alone", async () => {
  const f = fixture();
  const service = await f.runtime.runPromise(Models.Service);
  await f.runtime.runPromise(service.list());
  const scope = Scope.makeUnsafe();
  const notices = await f.runtime.runPromise(
    Events.allBounded(32).pipe(Scope.provide(scope)),
  );
  try {
    await f.update({
      models: { defaultModel: { providerID: CODEX, modelID: "tier2" } },
    });
    await f.runtime.runPromise(Effect.yieldNow);
    expect(f.createCodex).toHaveBeenCalledOnce();
    let finish!: () => void;
    f.codex.native.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ status: "ready", provider: f.codex.provider });
        }),
    );
    const pending = f.runtime.runPromiseExit(service.getModel(CODEX, model.id));
    await vi.waitFor(() =>
      expect(f.codex.native.discover).toHaveBeenCalledTimes(2),
    );
    const replacement = binding(CODEX);
    f.createCodex.mockReturnValue(replacement.native);
    await f.update({ models: { providers: { [CODEX]: { enabled: false } } } });
    await f.runtime.runPromise(
      notices.pipe(
        Stream.filter((event) => event.type === "models.changed"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      ),
    );
    expect(f.codex.native.dispose).toHaveBeenCalledOnce();
    finish();
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(await f.runtime.runPromise(service.list())).toEqual([]);
    await expect(
      f.runtime.runPromise(service.getModel(CODEX, model.id)),
    ).rejects.toBeInstanceOf(ModelNotFound);
    expect(replacement.native.dispose).not.toHaveBeenCalled();
  } finally {
    await f.runtime.runPromise(Scope.close(scope, Exit.void));
  }
});

test("invalid settings dispose clients and fail lookups until settings recover", async () => {
  const f = fixture();
  const service = await f.runtime.runPromise(Models.Service);
  await f.update({
    models: { providers: { [CODEX]: { enabled: "invalid" } } },
  });
  await vi.waitFor(() => expect(f.codex.native.dispose).toHaveBeenCalledOnce());
  for (const operation of [
    service.list(),
    service.getModel(CODEX, model.id),
    service.getLanguage(model),
  ]) {
    await expect(
      f.runtime.runPromise<unknown, ModelError>(operation),
    ).rejects.toMatchObject({
      _tag: "Models.ConfigurationUnavailable",
    });
  }
  const replacement = binding(CODEX);
  f.createCodex.mockReturnValue(replacement.native);
  await f.update({});
  await vi.waitFor(() => expect(f.createCodex).toHaveBeenCalledTimes(2));
  expect(await f.runtime.runPromise(service.getLanguage(model))).toBe(
    replacement.language,
  );
});

test("disabled providers remain inspectable and explicit refresh replaces both clients and cache", async () => {
  const f = fixture({ models: { providers: { [CODEX]: { enabled: false } } } });
  const service = await f.runtime.runPromise(Models.Service);
  expect(await f.runtime.runPromise(service.discover(CODEX))).toMatchObject({
    status: "ready",
  });
  expect(await f.runtime.runPromise(service.list())).toEqual([]);
  for (const operation of [
    service.getModel(CODEX, model.id),
    service.getLanguage(model),
  ]) {
    await expect(
      f.runtime.runPromise<unknown, ModelError>(operation),
    ).rejects.toBeInstanceOf(ModelNotFound);
  }
  expect(f.codex.native.discover).toHaveBeenCalledOnce();
  await f.runtime.runPromise(service.refresh());
  expect(f.codex.native.dispose).toHaveBeenCalledOnce();
  expect(f.claude.native.dispose).toHaveBeenCalledOnce();
  expect(f.createCodex).toHaveBeenCalledTimes(2);
  await f.runtime.runPromise(service.list());
  expect(f.claude.native.discover).toHaveBeenCalledTimes(2);
});

test("quota reads the binding fresh regardless of enablement and wraps failures without touching discovery", async () => {
  const f = fixture({ models: { providers: { [CODEX]: { enabled: false } } } });
  const service = await f.runtime.runPromise(Models.Service);
  const ready = { status: "ready", meters: [] } as const;
  f.codex.native.readQuota.mockResolvedValueOnce(ready);
  expect(await f.runtime.runPromise(service.quota(CODEX))).toEqual(ready);
  expect(await f.runtime.runPromise(service.quota(CODEX))).toEqual({
    status: "not_applicable",
  });
  expect(f.codex.native.readQuota).toHaveBeenCalledTimes(2);
  const cause = new Error("offline");
  f.codex.native.readQuota.mockRejectedValueOnce(cause);
  await expect(
    f.runtime.runPromise<unknown, QuotaUnavailable | ModelError>(
      service.quota(CODEX),
    ),
  ).rejects.toMatchObject({
    _tag: "Models.QuotaUnavailable",
    providerID: CODEX,
    cause,
  });
  expect(f.codex.native.discover).not.toHaveBeenCalled();
  expect(await f.runtime.runPromise(service.discover(CODEX))).toMatchObject({
    status: "ready",
  });
});

test.each(["discover", "list"] as const)(
  "%s overlapping replacement waits for cleanup before retrying",
  async (operation) => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.codex.native.discover.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const service = await f.runtime.runPromise(Models.Service);
    const inspecting = f.runtime.runPromiseExit<unknown, ModelError>(
      operation === "list" ? service.list() : service.discover(CODEX),
    );
    await vi.waitFor(() =>
      expect(f.codex.native.discover).toHaveBeenCalledOnce(),
    );
    f.codex.native.dispose.mockImplementationOnce(async () => {
      reject(new Error("disposed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    const replacement = binding(CODEX);
    replacement.native.discover.mockResolvedValue({
      status: "authentication_required",
      login: { executable: "/new/codex", args: ["login"] },
    });
    f.createCodex.mockReturnValue(replacement.native);
    await f.runtime.runPromise(service.refresh());
    expect(await inspecting).toMatchObject({
      _tag: "Success",
      value: operation === "list" ? [] : { status: "authentication_required" },
    });
    expect(replacement.native.discover).toHaveBeenCalledOnce();
  },
);

test("login completion refreshes only its provider, rechecks auth, and invalidates the list", async () => {
  const f = fixture();
  const service = await f.runtime.runPromise(Models.Service);
  await f.runtime.runPromise(service.list());
  f.codex.native.discover.mockResolvedValueOnce({
    status: "authentication_required",
    login: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
  });
  const replacement = binding(CODEX);
  f.createCodex.mockReturnValue(replacement.native);
  await f.runtime.runPromise(service.setup.start(CODEX, "login"));
  await vi.waitFor(async () =>
    expect(
      await f.runtime.runPromise(service.setup.state(CODEX)),
    ).toMatchObject({ status: "succeeded" }),
  );
  expect(f.createCodex).toHaveBeenCalledTimes(2);
  expect(f.createClaude).toHaveBeenCalledOnce();
  expect(f.codex.native.dispose).toHaveBeenCalledOnce();
  expect(f.claude.native.dispose).not.toHaveBeenCalled();
  expect(replacement.native.discover).toHaveBeenCalledOnce();
  await f.runtime.runPromise(service.list());
  expect(replacement.native.discover).toHaveBeenCalledTimes(2);
  await f.runtime.dispose();
  expect(replacement.native.dispose).toHaveBeenCalledOnce();
  expect(f.codex.native.dispose).toHaveBeenCalledOnce();
});

test("model settings expose only native providers", () => {
  const decode = Schema.decodeUnknownSync(ModelsSettings, {
    onExcessProperty: "error",
  });
  expect(decode({}).providers).toEqual({
    [CODEX]: { enabled: true },
    [CLAUDE_CODE]: { enabled: true },
    [ANTIGRAVITY]: { enabled: true },
  });
  expect(() =>
    decode({ providers: { "openai-compatible": { enabled: true } } }),
  ).toThrow();
});

test("interrupting setup cancellation still finishes replacing the released client", async () => {
  const f = fixture();
  const service = await f.runtime.runPromise(Models.Service);
  await f.runtime.runPromise(service.list());
  f.codex.native.discover.mockResolvedValueOnce({
    status: "authentication_required",
    login: {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
    },
  });
  const job = await f.runtime.runPromise(service.setup.start(CODEX, "login"));
  let finish!: () => void;
  f.codex.native.dispose.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const replacement = binding(CODEX, []);
  f.createCodex.mockReturnValue(replacement.native);
  const abort = new AbortController();
  const cancelling = f.runtime.runPromiseExit(
    service.setup.cancel(CODEX, job.id),
    { signal: abort.signal },
  );
  await vi.waitFor(() => expect(f.codex.native.dispose).toHaveBeenCalledOnce());
  abort.abort();
  finish();
  expect(Exit.isFailure(await cancelling)).toBe(true);
  expect(f.createCodex).toHaveBeenCalledTimes(2);
  expect(await f.runtime.runPromise(service.list())).toEqual([
    replacement.provider,
  ]);
  expect(f.claude.native.dispose).not.toHaveBeenCalled();
});
