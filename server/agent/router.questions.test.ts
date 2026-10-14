import { QueryClient } from "@tanstack/react-query";
// Purpose: Verifies native questions through real HTTP, AG-UI, and the app Session store.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { createAgentClient } from "@openchart/app/lib/agent/client";
import { createSessionStore } from "@openchart/app/lib/agent/session-store";
import { createTransport } from "@openchart/app/lib/transport/transport";
import { createRequestHandler } from "@openchart/server";
import { Question } from "@openchart/server/agent/question";
import { Session } from "@openchart/server/agent/session";
import { makeRuntime } from "@openchart/server/runtime";
import { Exit } from "effect";
import { EventSource } from "eventsource";
import { afterEach, expect, test } from "vitest";

const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function fixture() {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const handle = createRequestHandler(runtime);
  const connections = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/trpc/events.subscribe")) {
      connections.add(response);
      response.on("close", () => connections.delete(response));
    }
    handle(request, response);
  });
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await runtime.dispose();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP port");
  const remote = createAgentClient(
    createTransport(
      { origin: `http://127.0.0.1:${address.port}` },
      { EventSource },
    ),
  );
  const store = createSessionStore(
    remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(() => store.dispose());
  const sessions = await runtime.runPromise(Session.Service);

  async function observe(sessionID: string) {
    const session = store.getSession(sessionID);
    const unsubscribe = session.subscribe(() => {});
    disposals.push(unsubscribe);
    await expect.poll(() => session.getSnapshot().loading).toBe(false);
    return session;
  }

  const question = await runtime.runPromise(Question.Service);
  async function ask(sessionID: string, questionID = "mode") {
    const controller = new AbortController();
    const result = runtime.runPromiseExit(
      question.ask({
        sessionID,
        questions: [
          {
            id: questionID,
            header: "Mode",
            question: "Choose a mode",
            options: [
              { label: "Fast", description: "Quick result" },
              { label: "Thorough", description: "More detail" },
            ],
            multiple: false,
            allowFreeform: false,
            secret: false,
          },
        ],
      }),
      { signal: controller.signal },
    );
    disposals.push(async () => {
      controller.abort();
      await result;
    });
    await expect
      .poll(async () =>
        (await runtime.runPromise(question.list(sessionID))).find(
          (request) => request.questions[0]?.id === questionID,
        ),
      )
      .toBeDefined();
    const request = (await runtime.runPromise(question.list(sessionID))).find(
      (request) => request.questions[0]?.id === questionID,
    )!;
    return {
      request,
      result,
      cancel: async () => {
        controller.abort();
        await result;
      },
    };
  }
  return { runtime, sessions, store, connections, observe, ask };
}

test("answers a delegated question through HTTP and live state, validates replies, and rejects stale answers", async () => {
  const f = await fixture();
  const root = await f.runtime.runPromise(f.sessions.create({}));
  const child = await f.runtime.runPromise(
    f.sessions.create({ parentId: root.id, kind: "delegate" }),
  );
  const unrelated = await f.runtime.runPromise(f.sessions.create({}));
  const parent = await f.observe(root.id);
  const other = await f.observe(unrelated.id);
  const ask = await f.ask(child.id);
  await expect
    .poll(() => parent.getSnapshot().state?.questions)
    .toEqual([ask.request]);
  expect(other.getSnapshot().state?.questions).toEqual([]);
  expect(parent.getSnapshot().state?.permissions).toEqual([]);
  const invalidAnswers: Record<string, string[]>[] = [
    {},
    { mode: ["wrong"] },
    { mode: ["Fast", "Thorough"] },
    { mode: ["Fast"], extra: ["wrong"] },
  ];
  for (const answers of invalidAnswers) {
    await expect(
      parent.replyQuestion(ask.request.id, { type: "answered", answers }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
  }
  const reply = { type: "answered" as const, answers: { mode: ["Fast"] } };
  await parent.replyQuestion(ask.request.id, reply);
  expect(await ask.result).toEqual(Exit.succeed(reply));
  await expect.poll(() => parent.getSnapshot().state?.questions).toEqual([]);
  await expect(
    parent.replyQuestion(ask.request.id, reply),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  expect(parent.getSnapshot().state?.runs).toEqual([]);
});

test("cold snapshots and reconnect recover pending questions; skipping settles only one request", async () => {
  const f = await fixture();
  const root = await f.runtime.runPromise(f.sessions.create({}));
  const first = await f.ask(root.id, "first");
  const parent = await f.observe(root.id);
  expect(parent.getSnapshot().state?.questions).toEqual([first.request]);
  for (const response of f.connections) response.destroy();
  await expect.poll(() => f.connections.size).toBe(0);
  await first.cancel();
  const second = await f.ask(root.id, "second");
  const third = await f.ask(root.id, "third");
  await expect
    .poll(() => parent.getSnapshot().state?.questions, { timeout: 7000 })
    .toEqual([second.request, third.request]);
  await parent.replyQuestion(second.request.id, { type: "skipped" });
  expect(await second.result).toEqual(Exit.succeed({ type: "skipped" }));
  await expect
    .poll(() => parent.getSnapshot().state?.questions)
    .toEqual([third.request]);
  await third.cancel();
  await expect.poll(() => parent.getSnapshot().state?.questions).toEqual([]);
  expect(Exit.isFailure(await first.result)).toBe(true);
}, 10000);
