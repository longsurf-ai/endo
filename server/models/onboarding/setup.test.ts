// Purpose: Exercise startup installation and user-triggered login with scoped cleanup.
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { NodeServices } from "@effect/platform-node";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderDiscoveryResult } from "@openchart/models/model-provider";
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  MODEL_PROVIDER_IDS,
  type NativeProviderID,
} from "@openchart/models/model-tiers";
import { makeProviderSetup } from "./onboarding";
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposals.splice(0)) await close();
});
async function fixture(
  code: string,
  missing: NativeProviderID[] = [],
  installError?: Error,
) {
  const installed = new Set<NativeProviderID>(
    MODEL_PROVIDER_IDS.filter((id) => !missing.includes(id)),
  );
  let failOnce = installError;
  const installations = {
    executables: {
      [CODEX]: "/managed/codex",
      [CLAUDE_CODE]: "/managed/claude",
      [ANTIGRAVITY]: "/managed/antigravity",
    },
    installed: vi.fn(async (id: NativeProviderID) => installed.has(id)),
    install: vi.fn(async (id: NativeProviderID) => {
      if (id === CODEX && failOnce) {
        const error = failOnce;
        failOnce = undefined;
        throw error;
      }
      installed.add(id);
    }),
  };
  const discovery = vi.fn(() =>
    Effect.succeed<ProviderDiscoveryResult>({
      status: "authentication_required",
      login: { executable: process.execPath, args: ["-e", code] },
    }),
  );
  const refresh = vi.fn(() => Effect.void);
  // Keep setup in a separate long-lived scope, just like the Models service layer.
  class Setup extends Context.Service<
    Setup,
    Effect.Success<ReturnType<typeof makeProviderSetup>>
  >()("test/setup") {}
  const services = ManagedRuntime.make(
    Layer.effect(
      Setup,
      makeProviderSetup(discovery, refresh, installations, Effect.void, true),
    ).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  disposals.push(async () => {
    await services.dispose();
  });
  const setup = await services.runPromise(Setup);
  return { runtime: services, setup, discovery, refresh, installations };
}

test("does nothing before user action, accepts stdin, bounds output, and refreshes after exit", async () => {
  const f = await fixture(
    'process.stdout.write("x".repeat(40000)); process.stdin.once("data", data => {console.log("\\nCODE:" + data.toString().trim()); process.exit(0);});',
  );
  expect(f.discovery).not.toHaveBeenCalled();
  expect(await f.runtime.runPromise(f.setup.state(CODEX))).toEqual({
    status: "idle",
  });
  const started = await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  expect(started.status).toBe("running");
  await f.runtime.runPromise(
    f.setup.write(CODEX, started.id, "literal; $(echo unsafe)"),
  );
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "succeeded",
    }),
  );
  const result = await f.runtime.runPromise(f.setup.state(CODEX));
  if (result.status === "idle") throw new Error("Missing setup");
  expect(result.output).toContain("CODE:literal; $(echo unsafe)");
  expect(result.output.length).toBeLessThanOrEqual(32768);
  expect(f.refresh).toHaveBeenCalledOnce();
  await expect(
    f.runtime.runPromise(f.setup.write(CODEX, started.id, "late")),
  ).rejects.toMatchObject({ _tag: "Models.SetupFailed" });
});

test("rejects duplicate operations and cancellation kills and awaits the child", async () => {
  const f = await fixture(
    "console.log(process.pid); setInterval(() => {}, 1000);",
  );
  const started = await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  let pid = 0;
  await vi.waitFor(async () => {
    const state = await f.runtime.runPromise(f.setup.state(CODEX));
    if (state.status !== "idle") pid = Number(state.output.trim());
    expect(pid).toBeGreaterThan(0);
  });
  await expect(
    f.runtime.runPromise(f.setup.start(CODEX, "login")),
  ).rejects.toMatchObject({ _tag: "Models.SetupFailed" });
  await expect(
    f.runtime.runPromise(f.setup.cancel(CODEX, "stale")),
  ).rejects.toMatchObject({ _tag: "Models.SetupFailed" });
  await f.runtime.runPromise(f.setup.cancel(CODEX, started.id));
  expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
    status: "cancelled",
  });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.refresh).toHaveBeenCalledOnce();
});

test("scope shutdown kills the child without refreshing a closing registry", async () => {
  const f = await fixture(
    "console.log(process.pid); setInterval(() => {}, 1000);",
  );
  await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  let pid = 0;
  await vi.waitFor(async () => {
    const state = await f.runtime.runPromise(f.setup.state(CODEX));
    if (state.status !== "idle") pid = Number(state.output.trim());
    expect(pid).toBeGreaterThan(0);
  });
  await f.runtime.dispose();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.refresh).not.toHaveBeenCalled();
});

test("accepted setup can be cancelled before process startup completes", async () => {
  const f = await fixture("setInterval(() => {}, 1000);");
  await f.runtime.runPromise(
    Effect.gen(function* () {
      const started = yield* f.setup.start(CODEX, "login");
      yield* f.setup.cancel(CODEX, started.id);
      expect(yield* f.setup.state(CODEX)).toMatchObject({
        id: started.id,
        status: "cancelled",
      });
    }),
  );
});

test("nonzero exit is a failed operation and can be retried", async () => {
  const f = await fixture('console.error("Login rejected"); process.exit(3);');
  const first = await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "failed",
      output: expect.stringContaining("Login rejected"),
    }),
  );
  expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
    output: expect.stringContaining("Sign-in exited with code 3."),
  });
  const second = await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  expect(second.id).not.toBe(first.id);
});

test("fresh discovery rejects login for an already ready provider", async () => {
  const f = await fixture("process.exit(99);");
  f.discovery.mockImplementation(() =>
    Effect.succeed({
      status: "ready",
      provider: { id: CODEX, name: "Codex", models: [] },
    }),
  );
  await expect(
    f.runtime.runPromise(f.setup.start(CODEX, "login")),
  ).rejects.toMatchObject({ _tag: "Models.SetupFailed" });
  expect(await f.runtime.runPromise(f.setup.state(CODEX))).toEqual({
    status: "idle",
  });
});

test("accepted setup reports spawn failure through state and allows retry", async () => {
  const f = await fixture("process.exit(0);");
  f.discovery.mockImplementationOnce(() =>
    Effect.succeed({
      status: "authentication_required",
      login: { executable: "/missing/openchart-cli", args: ["login"] },
    }),
  );
  const first = await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      id: first.id,
      status: "failed",
      output: expect.stringContaining("Setup did not complete"),
    }),
  );
  const second = await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  expect(second.id).not.toBe(first.id);
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      id: second.id,
      status: "succeeded",
    }),
  );
});

test("deadline terminates an abandoned login and reports failure", async () => {
  const f = await fixture(
    "console.log(process.pid); setInterval(() => {}, 1000);",
  );
  await f.runtime.runPromise(f.setup.start(CODEX, "login"));
  let pid = 0;
  await vi.waitFor(async () => {
    const state = await f.runtime.runPromise(f.setup.state(CODEX));
    if (state.status !== "idle") pid = Number(state.output.trim());
    expect(pid).toBeGreaterThan(0);
  });
  await f.runtime.runPromise(TestClock.adjust("15 minutes"));
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "failed",
    }),
  );
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.refresh).toHaveBeenCalledOnce();
});

test("startup installs both missing providers and refreshes their sign-in status", async () => {
  const f = await fixture("process.exit(99)", [CODEX, CLAUDE_CODE]);
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "succeeded",
      action: "install",
    }),
  );
  await vi.waitFor(async () =>
    expect(
      await f.runtime.runPromise(f.setup.state(CLAUDE_CODE)),
    ).toMatchObject({
      status: "succeeded",
      action: "install",
    }),
  );
  expect(f.installations.install).toHaveBeenCalledTimes(2);
  expect(f.installations.install).toHaveBeenCalledWith(
    CODEX,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(f.installations.install).toHaveBeenCalledWith(
    CLAUDE_CODE,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(f.refresh).toHaveBeenCalledWith(CODEX);
  expect(f.refresh).toHaveBeenCalledWith(CLAUDE_CODE);
  await expect(
    f.runtime.runPromise(f.setup.start(CODEX, "install")),
  ).rejects.toMatchObject({ _tag: "Models.SetupFailed" });
});

test("startup skips an installed provider and installs a missing one", async () => {
  const f = await fixture("process.exit(99)", [CODEX]);
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "succeeded",
      action: "install",
    }),
  );
  expect(f.installations.install).toHaveBeenCalledOnce();
  expect(await f.runtime.runPromise(f.setup.state(CLAUDE_CODE))).toEqual({
    status: "idle",
  });
  expect(f.refresh).toHaveBeenCalledWith(CODEX);
});

test("download failures stay visible and a later click can retry", async () => {
  const f = await fixture(
    "process.exit(99)",
    [CODEX],
    new Error("Network unavailable"),
  );
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "failed",
      output: expect.stringContaining("Network unavailable"),
    }),
  );
  await f.runtime.runPromise(f.setup.start(CODEX, "install"));
  await vi.waitFor(async () =>
    expect(await f.runtime.runPromise(f.setup.state(CODEX))).toMatchObject({
      status: "succeeded",
    }),
  );
});
