// Purpose: Verify model choices and explicit setup actions through the shared transport.
import { once } from "node:events";
import { createServer } from "node:http";
import { createTRPCClient, httpLink } from "@trpc/client";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { expect, test, vi } from "vitest";
import { createRequestHandler, type AppRouter } from "@openchart/server";
import { makeRuntime } from "@openchart/server/runtime";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { CODEX, CLAUDE_CODE } from "@openchart/models/model-tiers";
import { AvailableModel } from "@openchart/models/model-provider";
import { Models } from "./models";
import { QuotaUnavailable } from "./errors";
import { SetupFailed } from "./onboarding/errors";

async function serve() {
  const application = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const discovery: Models.Interface["discover"] = (id) =>
    Effect.succeed({
      status: "authentication_required",
      login: { executable: `/native/${id}`, args: ["login"] },
    });
  const service = {
    discover: vi.fn(discovery),
    quota: vi.fn<Models.Interface["quota"]>(() =>
      Effect.succeed({ status: "not_applicable" }),
    ),
    refresh: vi.fn(() => Effect.void),
    list: vi.fn<Models.Interface["list"]>(() => Effect.succeed([])),
    getModel: () => Effect.die("Unexpected lookup"),
    getLanguage: () => Effect.die("Unexpected SDK"),
    setup: {
      state: vi.fn<Models.Interface["setup"]["state"]>(() =>
        Effect.succeed({ status: "idle" }),
      ),
      start: vi.fn<Models.Interface["setup"]["start"]>(() =>
        Effect.succeed({
          status: "running",
          id: "operation",
          action: "login",
          output: "",
        }),
      ),
      write: vi.fn(() => Effect.void),
      cancel: vi.fn(() => Effect.void),
    },
  } satisfies Models.Interface;
  const runtime = ManagedRuntime.make(
    Layer.succeedContext(
      Context.add(await application.context(), Models.Service, service),
    ),
  );
  const server = createServer(createRequestHandler(runtime));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const url = `http://127.0.0.1:${address.port}/trpc`;
  return {
    service,
    url,
    client: createTRPCClient<AppRouter>({ links: [httpLink({ url })] }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.dispose();
      await application.dispose();
    },
  };
}

test("lists tier choices under models without the old Agent route", async () => {
  const f = await serve();
  try {
    const model = AvailableModel.parse({
      kind: "language",
      providerID: CODEX,
      id: "test-model",
      name: "Test model",
      tier: 1,
      capabilities: { input: { text: true }, output: { text: true } },
      availableVariants: ["low", "high"],
    });
    f.service.list.mockReturnValueOnce(
      Effect.succeed([{ id: CODEX, name: "Codex", models: [model] }]),
    );
    expect(await f.client.models.list.query()).toEqual([
      {
        id: CODEX,
        name: "Codex",
        models: [
          { ...model, id: "tier5" },
          { ...model, id: "tier4" },
          { ...model, id: "tier3" },
          { ...model, id: "tier2" },
          { ...model, id: "tier1" },
        ],
      },
    ]);
    expect(await f.client.models.list.query()).toEqual([]);
    expect((await fetch(`${f.url}/agent.models`)).status).toBe(404);
  } finally {
    await f.close();
  }
});

test("inspection is independent per provider and never starts login", async () => {
  const f = await serve();
  try {
    for (const providerID of [CODEX, CLAUDE_CODE] as const) {
      expect(
        await f.client.models.discover.query({ providerID }),
      ).toMatchObject({ status: "authentication_required" });
    }
    expect(f.service.setup.start).not.toHaveBeenCalled();
    expect(
      await f.client.models.setupState.query({ providerID: CODEX }),
    ).toEqual({ status: "idle" });
    await f.client.models.startSetup.mutate({
      providerID: CODEX,
      action: "login",
    });
    expect(f.service.setup.start).toHaveBeenCalledExactlyOnceWith(
      CODEX,
      "login",
    );
    await f.client.models.writeSetup.mutate({
      providerID: CODEX,
      id: "operation",
      text: "code",
    });
    expect(f.service.setup.write).toHaveBeenCalledExactlyOnceWith(
      CODEX,
      "operation",
      "code",
    );
    await f.client.models.cancelSetup.mutate({
      providerID: CODEX,
      id: "operation",
    });
    expect(f.service.setup.cancel).toHaveBeenCalledExactlyOnceWith(
      CODEX,
      "operation",
    );
    await f.client.models.refresh.mutate();
    expect(f.service.refresh).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

test("quota reads each provider through the service and reports failures separately", async () => {
  const f = await serve();
  try {
    for (const providerID of [CODEX, CLAUDE_CODE] as const) {
      expect(await f.client.models.quota.query({ providerID })).toEqual({
        status: "not_applicable",
      });
      expect(f.service.quota).toHaveBeenLastCalledWith(providerID);
    }
    f.service.quota.mockReturnValueOnce(
      Effect.fail(
        new QuotaUnavailable({
          providerID: CODEX,
          cause: new Error("offline"),
        }),
      ),
    );
    await expect(
      f.client.models.quota.query({ providerID: CODEX }),
    ).rejects.toMatchObject({
      message: "Plan usage could not be read. Try again.",
      data: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(
      await fetch(
        `${f.url}/models.quota?input=${encodeURIComponent(JSON.stringify({ providerID: "openai-compatible" }))}`,
      ),
    ).toHaveProperty("status", 400);
    expect(f.service.discover).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("rejects arbitrary executables, arguments, providers, and query-side mutations", async () => {
  const f = await serve();
  try {
    for (const input of [
      {
        providerID: CODEX,
        action: "login",
        executable: "/bin/sh",
        args: ["-c", "echo injected"],
      },
      { providerID: CODEX, action: "execute" },
      { providerID: "openai-compatible", action: "login" },
      { providerID: CODEX, action: "login", env: { PATH: "/tmp" } },
    ]) {
      const response = await fetch(`${f.url}/models.startSetup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
    }
    expect((await fetch(`${f.url}/models.startSetup`)).status).toBe(405);
    expect(f.service.setup.start).not.toHaveBeenCalled();
    f.service.setup.start.mockReturnValueOnce(
      Effect.fail(
        new SetupFailed({
          message: "Setup is already running for this provider.",
        }),
      ),
    );
    await expect(
      f.client.models.startSetup.mutate({ providerID: CODEX, action: "login" }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT" } });
  } finally {
    await f.close();
  }
});
