// Purpose: Locks server composition, startup, local access, and SSE delivery.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { ConfigProvider, Effect, Fiber, Schema, Stream } from "effect";
import { EventSource } from "eventsource";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { makeRuntime } from "./runtime";
import { EventDefinition, Events } from "./events/index";
import { createServer, router } from "./index";

const RuntimeProbe = EventDefinition.define({
  type: "test.runtime-probe",
  schema: { message: Schema.String },
});

test("creates a host from an empty configuration", async () => {
  const server = await createServer({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  await server.shutdown();
});

test("runs the echo tRPC procedure through the managed Effect runtime", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  try {
    const caller = router.createCaller({ runtime });
    await expect(caller.echo({ message: "hello" })).resolves.toEqual({
      message: "hello",
    });
  } finally {
    await runtime.dispose();
  }
});

test("provides one shared Events service through the managed runtime", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  try {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Events.Service;
        const live = yield* events.allBounded(256);
        const received = yield* live.pipe(
          Stream.filter((event) => event.type === RuntimeProbe.type),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const sent = yield* events.publish(RuntimeProbe, { message: "hello" });
        return { sent, received: Array.from(yield* Fiber.join(received)) };
      }),
    );

    const result = await runtime.runPromise(program);
    expect(result.received).toEqual([result.sent]);
  } finally {
    await runtime.dispose();
  }
});

test("initializes the application before returning an unbound server", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "openchart-server-start-"));
  const home = path.join(directory, "profile");
  const databasePath = path.join(home, "openchart.sqlite3");
  try {
    const server = await createServer({ home });
    try {
      expect(server.listening).toBe(false);
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      await server.shutdown();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const access = { token: "per-run-secret", origin: "openchart://app" };
const bearer = { authorization: `Bearer ${access.token}` };
const origin = { origin: access.origin };

async function listenWithAccess() {
  const server = await createServer(
    {
      home: temporaryHome(),
      databasePath: ":memory:",
      config: ConfigProvider.fromUnknown({}),
    },
    { access },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  return { server, port: address.port, host: `127.0.0.1:${address.port}` };
}

// node:http, not fetch: fetch cannot forge the Host header.
function send(url: string, headers: Record<string, string>, method = "GET") {
  return new Promise<IncomingMessage>((resolve, reject) => {
    httpRequest(url, { method, headers }, (response) => {
      response.resume();
      resolve(response);
    })
      .on("error", reject)
      .end();
  });
}

test("access answers 401 unless Host, Origin, and token all match", async () => {
  const { server, port, host } = await listenWithAccess();
  try {
    const echo = `http://${host}/trpc/echo?input=${encodeURIComponent(
      JSON.stringify({ message: "hi" }),
    )}`;
    expect((await send(echo, origin)).statusCode).toBe(401);
    expect(
      (
        await send(echo, {
          ...origin,
          authorization: `Bearer ${"x".repeat(access.token.length)}`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await send(echo, { ...bearer, origin: "http://evil.example" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await send(echo, { ...bearer, ...origin, host: `localhost:${port}` }))
        .statusCode,
    ).toBe(401);
    const accepted = await send(echo, { ...bearer, ...origin });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["access-control-allow-origin"]).toBe(access.origin);
    expect(accepted.headers.vary).toContain("Origin");
    const missing = await send(`http://${host}/missing`, {
      ...bearer,
      ...origin,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.vary).toBe("Origin");
    const preflight = await send(echo, origin, "OPTIONS");
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers).toMatchObject({
      "access-control-allow-origin": access.origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      vary: "Origin",
    });
  } finally {
    await server.shutdown();
  }
});

test("malformed request targets reject without stopping the backend", async () => {
  const { server, host } = await listenWithAccess();
  try {
    const malformed = `http://${host}//[`;
    expect((await send(malformed, origin)).statusCode).toBe(401);
    expect((await send(malformed, { ...bearer, ...origin })).statusCode).toBe(
      401,
    );
    expect((await send(malformed, origin, "OPTIONS")).statusCode).toBe(401);
    const echo = `http://${host}/trpc/echo?input=${encodeURIComponent(
      JSON.stringify({ message: "still alive" }),
    )}`;
    expect((await send(echo, { ...bearer, ...origin })).statusCode).toBe(200);
  } finally {
    await server.shutdown();
  }
});

test("events.subscribe streams over SSE with the bearer token", async () => {
  const { server, host } = await listenWithAccess();
  const client = createTRPCClient<typeof router>({
    links: [
      httpSubscriptionLink({
        url: `http://${host}/trpc`,
        EventSource,
        eventSourceOptions: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              headers: { ...init.headers, ...bearer, ...origin },
            }),
        },
      }),
    ],
  });
  const frames: unknown[] = [];
  const failures: unknown[] = [];
  const subscription = client.events.subscribe.subscribe(undefined, {
    onData: (frame) => frames.push(frame),
    onError: (error) => failures.push(error),
  });
  try {
    await expect.poll(() => frames[0]).toEqual({ kind: "ready" });
    expect(failures).toEqual([]);
  } finally {
    subscription.unsubscribe();
    await server.shutdown();
  }
});
