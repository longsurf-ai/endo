// Purpose: Proves the generic tRPC subscription emits real SSE without production event definitions.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { once } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import { trpc } from "@openchart/server/lib/trpc";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { ConfigProvider, Schema } from "effect";
import { expect, test } from "vitest";

import { makeRuntime } from "@openchart/server/runtime";
import { EventDefinition, Events } from "./index";
import { eventsRouter } from "./router";

const Probe = EventDefinition.define({
  type: "test.transport",
  schema: { message: Schema.String },
});

const testRouter = trpc.router({ events: eventsRouter });

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { value: string },
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  while (!buffer.value.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error(`SSE ended before receiving ${expected}`);
    }
    buffer.value += decoder.decode(chunk.value, { stream: true });
  }
  return buffer.value;
}

test("streams a test-only generic event through tRPC SSE", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  const handler = createHTTPHandler({
    basePath: "/trpc/",
    router: testRouter,
    createContext: () => ({ runtime }),
  });
  const server = createHttpServer(handler);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the test server to listen on a TCP port");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/trpc/events.subscribe`,
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("Expected an SSE response body");

    const reader = response.body.getReader();
    const buffer = { value: "" };
    await readUntil(reader, buffer, '"kind":"ready"');
    const delivered = readUntil(reader, buffer, "test.transport");

    const events = await runtime.runPromise(Events.Service);
    const sent = await runtime.runPromise(
      events.publish(Probe, { message: "hello" }),
    );
    const body = await delivered;

    expect(body).toContain(sent.id);
    expect(body.indexOf('"kind":"ready"')).toBeLessThan(body.indexOf(sent.id));
    expect(body).toContain("test.transport");
    expect(body).toContain("hello");
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await close(server);
    await runtime.dispose();
  }
});
