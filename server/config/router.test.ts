// Purpose: Verifies file-backed Config through real HTTP mutation/query and shared SSE transport.
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  GROK,
  OPENCODE,
} from "@openchart/models/model-tiers";

import { createServer, type AppRouter } from "@openchart/server";
import type { inferRouterOutputs } from "@trpc/server";
import {
  createTRPCClient,
  httpLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/client";
import { EventSource } from "eventsource";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

type Frame =
  inferRouterOutputs<AppRouter>["events"]["subscribe"] extends AsyncIterable<
    infer Event
  >
    ? Event
    : never;

const nativeDisabled = {
  models: {
    providers: {
      [CODEX]: { enabled: false },
      [CLAUDE_CODE]: { enabled: false },
      [ANTIGRAVITY]: { enabled: false },
      [GROK]: { enabled: false },
      [OPENCODE]: { enabled: false },
    },
  },
};

async function serve(initial?: object) {
  const directory = await mkdtemp(join(tmpdir(), "openchart-config-http-"));
  const filename = join(directory, "settings.json");
  if (initial !== undefined) await writeFile(filename, JSON.stringify(initial));
  const server = await createServer({
    home: directory,
    models: {
      fetchEnabled: false,
      userAgent: "Endo/ConfigTest",
    },
  }).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server port");
  const url = `http://127.0.0.1:${address.port}/trpc`;
  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: httpSubscriptionLink({ url, EventSource }),
        false: httpLink({ url }),
      }),
    ],
  });
  return {
    directory,
    filename,
    server,
    client,
    url,
    async close() {
      await server.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function subscribe(client: Awaited<ReturnType<typeof serve>>["client"]) {
  const frames: Frame[] = [];
  const errors: unknown[] = [];
  const subscription = client.events.subscribe.subscribe(undefined, {
    onData: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });
  try {
    await vi.waitFor(() => expect(frames).toContainEqual({ kind: "ready" }));
  } catch (error) {
    subscription.unsubscribe();
    throw error;
  }
  return {
    subscription,
    frames,
    errors,
    changes: () =>
      frames.filter(
        (frame) =>
          frame.kind === "event" && frame.event.type === "config.changed",
      ),
  };
}

test("returns domain defaults without creating settings.json, then persists only edited values", async () => {
  const fixture = await serve();
  try {
    expect(await fixture.client.config.get.query()).toMatchObject({
      appearance: { theme: "system" },
      notifications: { sound: "chime" },
      models: {
        permissionMode: "full-access",
        providers: {
          [CODEX]: { enabled: true },
          [CLAUDE_CODE]: { enabled: true },
        },
      },
    });
    await expect(readFile(fixture.filename, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fixture.client.config.update.mutate({
      appearance: { theme: "dark" },
    });
    expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toEqual({
      appearance: { theme: "dark" },
    });
    await fixture.client.config.update.mutate({ appearance: { theme: null } });
    expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toEqual({
      appearance: {},
    });
    expect((await fixture.client.config.get.query()).appearance.theme).toBe(
      "system",
    );
  } finally {
    await fixture.close();
  }
});

test("preserves private namespaces, merges independent changes, and resets whole domains", async () => {
  const initial = {
    ...nativeDisabled,
    privateNamespace: { unchanged: "not exposed" },
    appearance: { theme: "dark" },
  };
  const fixture = await serve(initial);
  try {
    expect(await fixture.client.config.get.query()).not.toHaveProperty(
      "privateNamespace",
    );
    await Promise.all([
      fixture.client.config.update.mutate({ appearance: { theme: "light" } }),
      fixture.client.config.update.mutate({
        notifications: { sound: "none" },
      }),
      fixture.client.config.update.mutate({
        models: { permissionMode: "ask" },
      }),
    ]);
    expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toEqual({
      ...initial,
      appearance: { theme: "light" },
      notifications: { sound: "none" },
      models: { ...nativeDisabled.models, permissionMode: "ask" },
    });
    await fixture.client.config.update.mutate({
      appearance: null,
      notifications: null,
    });
    expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toEqual({
      privateNamespace: initial.privateNamespace,
      models: { ...nativeDisabled.models, permissionMode: "ask" },
    });
    expect(await fixture.client.config.get.query()).toMatchObject({
      appearance: { theme: "system" },
      notifications: { sound: "chime" },
      models: { permissionMode: "ask" },
    });
  } finally {
    await fixture.close();
  }
});

test("persists notification sound choices, rejects unknown assets and resets to the default", async () => {
  const fixture = await serve(nativeDisabled);
  try {
    await fixture.client.config.update.mutate({
      notifications: { sound: "glass" },
    });
    expect((await fixture.client.config.get.query()).notifications.sound).toBe(
      "glass",
    );
    expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toMatchObject({
      notifications: { sound: "glass" },
    });
    await expect(
      fixture.client.config.update.mutate(
        JSON.parse('{"notifications":{"sound":"../../custom.wav"}}'),
      ),
    ).rejects.toThrow();
    expect((await fixture.client.config.get.query()).notifications.sound).toBe(
      "glass",
    );
    await fixture.client.config.update.mutate({
      notifications: { sound: "none" },
    });
    expect((await fixture.client.config.get.query()).notifications.sound).toBe(
      "none",
    );
    await fixture.client.config.update.mutate({ notifications: null });
    expect((await fixture.client.config.get.query()).notifications.sound).toBe(
      "chime",
    );
    expect(
      JSON.parse(await readFile(fixture.filename, "utf8")),
    ).not.toHaveProperty("notifications");
  } finally {
    await fixture.close();
  }
});

test("persists model permission modes independently of other settings and resets to full access", async () => {
  const fixture = await serve(nativeDisabled);
  try {
    for (const permissionMode of ["full-access", "ask", "auto"] as const) {
      await fixture.client.config.update.mutate({
        models: { permissionMode },
      });
      expect(
        (await fixture.client.config.get.query()).models.permissionMode,
      ).toBe(permissionMode);
      expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toEqual({
        models: { ...nativeDisabled.models, permissionMode },
      });
    }

    const defaultModel = { providerID: CODEX, modelID: "tier1" } as const;
    await fixture.client.config.update.mutate({ models: { defaultModel } });
    expect((await fixture.client.config.get.query()).models).toEqual({
      ...nativeDisabled.models,
      permissionMode: "auto",
      defaultModel,
    });

    await fixture.client.config.update.mutate({
      models: { permissionMode: null },
    });
    expect((await fixture.client.config.get.query()).models).toEqual({
      ...nativeDisabled.models,
      permissionMode: "full-access",
      defaultModel,
    });
    expect(JSON.parse(await readFile(fixture.filename, "utf8"))).toEqual({
      models: { ...nativeDisabled.models, defaultModel },
    });
  } finally {
    await fixture.close();
  }
});

test("rejects malformed patches and invalid merged domains without any partial write", async () => {
  const fixture = await serve(nativeDisabled);
  try {
    const before = await readFile(fixture.filename, "utf8");
    for (const patch of [
      null,
      [],
      { unknown: null },
      { appearance: { theem: null } },
      { appearance: { theme: "invalid" } },
      { dashboard: "invalid" },
      {
        appearance: { theme: "dark" },
        notifications: { sound: "missing.wav" },
      },
      { models: { providers: { ["openai-compatible"]: { enabled: true } } } },
      { models: { defaultModel: { providerID: CODEX } } },
      { models: { permissionMode: "yolo" } },
      { models: { permissionMode: true } },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ]) {
      const response = await fetch(`${fixture.url}/config.update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(400);
      expect(await readFile(fixture.filename, "utf8")).toBe(before);
    }
    expect(
      (await readdir(fixture.directory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("SSE publishes writes once, invalidates broken files, and recovers after replacement or deletion", async () => {
  const fixture = await serve(nativeDisabled);
  const live = await subscribe(fixture.client);
  try {
    await fixture.client.config.update.mutate({
      appearance: { theme: "dark" },
    });
    await vi.waitFor(() => expect(live.changes()).toHaveLength(1));
    expect(live.changes()[0]).toMatchObject({
      kind: "event",
      event: { type: "config.changed", data: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(live.changes()).toHaveLength(1);
    await fixture.client.config.update.mutate({
      appearance: { theme: "dark" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(live.changes()).toHaveLength(1);

    await writeFile(fixture.filename, "{");
    await vi.waitFor(() => expect(live.changes()).toHaveLength(2));
    await expect(fixture.client.config.get.query()).rejects.toBeDefined();
    await expect(
      fixture.client.config.update.mutate({ appearance: { theme: "light" } }),
    ).rejects.toBeDefined();
    expect(await readFile(fixture.filename, "utf8")).toBe("{");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(live.changes()).toHaveLength(2);

    const temporary = join(fixture.directory, "replacement.json");
    await writeFile(
      temporary,
      JSON.stringify({ ...nativeDisabled, appearance: { theme: "light" } }),
    );
    await rename(temporary, fixture.filename);
    await vi.waitFor(() => expect(live.changes()).toHaveLength(3));
    expect((await fixture.client.config.get.query()).appearance.theme).toBe(
      "light",
    );
    await unlink(fixture.filename);
    await vi.waitFor(() => expect(live.changes()).toHaveLength(4));
    expect((await fixture.client.config.get.query()).appearance.theme).toBe(
      "system",
    );
    expect(live.errors).toEqual([]);
  } finally {
    live.subscription.unsubscribe();
    await fixture.close();
  }
}, 15_000);

test("a reconnected SSE subscriber rereads current config and server shutdown closes the stream", async () => {
  const fixture = await serve(nativeDisabled);
  const first = await subscribe(fixture.client);
  first.subscription.unsubscribe();
  await fixture.client.config.update.mutate({ appearance: { theme: "dark" } });
  const second = await subscribe(fixture.client);
  try {
    expect(second.changes()).toEqual([]);
    expect((await fixture.client.config.get.query()).appearance.theme).toBe(
      "dark",
    );
    const response = await fetch(`${fixture.url}/events.subscribe`);
    const reader = response.body!.getReader();
    await reader.read();
    // Attach rejection handling before shutdown begins closing the socket.
    const ended = expect(reader.read()).rejects.toBeDefined();
    await fixture.server.shutdown();
    await ended;
    expect(fixture.server.listening).toBe(false);
  } finally {
    second.subscription.unsubscribe();
    await fixture.close();
  }
});
