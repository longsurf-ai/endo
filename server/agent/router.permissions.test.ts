import { QueryClient } from "@tanstack/react-query";
// Purpose: Verifies delegated approvals through real HTTP, AG-UI, and the app Session store.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { createAgentClient } from "@openchart/app/lib/agent/client";
import { createSessionStore } from "@openchart/app/lib/agent/session-store";
import { createTransport } from "@openchart/app/lib/transport/transport";
import { createRequestHandler } from "@openchart/server";
import { Permission } from "@openchart/server/agent/permission";
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
  const permission = await runtime.runPromise(Permission.Service);

  async function observe(sessionID: string) {
    const session = store.getSession(sessionID);
    const unsubscribe = session.subscribe(() => {});
    disposals.push(unsubscribe);
    await expect.poll(() => session.getSnapshot().loading).toBe(false);
    return session;
  }

  function ask(sessionID: string, name: string) {
    const id = Permission.ID.make(`per_${name}`);
    const controller = new AbortController();
    const result = runtime.runPromiseExit(
      permission.ask({
        id,
        sessionID,
        agent: null,
        action: "read",
        resources: [name],
      }),
      { signal: controller.signal },
    );
    const cancel = async () => {
      controller.abort();
      await result;
    };
    disposals.push(cancel);
    return { id, result, cancel };
  }

  return { runtime, sessions, permission, store, connections, observe, ask };
}

type SessionHandle = ReturnType<
  ReturnType<typeof createSessionStore>["getSession"]
>;

function requests(session: SessionHandle) {
  return session
    .getSnapshot()
    .state?.permissions.map((request) => ({
      id: request.id,
      sessionID: request.sessionID,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

test("parent approvals include concurrent and nested delegates without ToolParts, with replies and cleanup scoped to their owners", async () => {
  const f = await fixture();
  const root = await f.runtime.runPromise(f.sessions.create({}));
  const left = await f.runtime.runPromise(
    f.sessions.create({ parentId: root.id, kind: "delegate" }),
  );
  const right = await f.runtime.runPromise(
    f.sessions.create({ parentId: root.id, kind: "delegate" }),
  );
  const nested = await f.runtime.runPromise(
    f.sessions.create({ parentId: left.id, kind: "delegate" }),
  );
  const other = await f.runtime.runPromise(f.sessions.create({}));
  const branch = await f.runtime.runPromise(
    f.sessions.create({ parentId: root.id, kind: "dig_in" }),
  );
  const branchChild = await f.runtime.runPromise(
    f.sessions.create({ parentId: branch.id, kind: "delegate" }),
  );
  const parent = await f.observe(root.id);

  const own = f.ask(root.id, "own");
  const a = f.ask(left.id, "left_a");
  const b = f.ask(left.id, "left_b");
  const c = f.ask(right.id, "right");
  const d = f.ask(nested.id, "nested");
  const unrelated = f.ask(other.id, "unrelated");
  const branched = f.ask(branchChild.id, "branched");
  const visible = [
    { id: a.id, sessionID: left.id },
    { id: b.id, sessionID: left.id },
    { id: d.id, sessionID: nested.id },
    { id: own.id, sessionID: root.id },
    { id: c.id, sessionID: right.id },
  ];
  await expect
    .poll(() => f.runtime.runPromise(f.permission.list()))
    .toHaveLength(7);
  // Only the parent is observed while these live requests arrive.
  await expect.poll(() => requests(parent)).toEqual(visible);
  expect(parent.getSnapshot().messages).toEqual([]);
  const child = await f.observe(left.id);
  expect(requests(child)).toEqual(visible.slice(0, 3));
  const sibling = await f.observe(right.id);
  expect(requests(sibling)).toEqual([{ id: c.id, sessionID: right.id }]);
  expect(requests(await f.observe(other.id))).toEqual([
    { id: unrelated.id, sessionID: other.id },
  ]);
  expect(requests(await f.observe(branch.id))).toEqual([
    { id: branched.id, sessionID: branchChild.id },
  ]);

  await parent.replyPermission(a.id, "reject");
  expect(Exit.isFailure(await a.result)).toBe(true);
  expect(Exit.isFailure(await b.result)).toBe(true);
  await expect.poll(() => requests(parent)).toEqual(visible.slice(2));
  await expect.poll(() => requests(child)).toEqual([visible[2]]);
  expect(requests(sibling)).toEqual([visible[4]]);

  await d.cancel();
  await expect.poll(() => requests(parent)).toEqual(visible.slice(3));
  await expect.poll(() => requests(child)).toEqual([]);
  await parent.replyPermission(c.id, "once");
  expect(Exit.isSuccess(await c.result)).toBe(true);
  await expect.poll(() => requests(parent)).toEqual([visible[3]]);
  await expect.poll(() => requests(sibling)).toEqual([]);
  await parent.replyPermission(own.id, "once");
  expect(Exit.isSuccess(await own.result)).toBe(true);
  await expect.poll(() => requests(parent)).toEqual([]);
  expect(
    (await f.runtime.runPromise(f.permission.list()))
      .map((request) => request.id)
      .sort(),
  ).toEqual([branched.id, unrelated.id]);
});

test("cold load and reconnect recover the same delegated approvals as live updates", async () => {
  const f = await fixture();
  const root = await f.runtime.runPromise(f.sessions.create({}));
  const child = await f.runtime.runPromise(
    f.sessions.create({ parentId: root.id, kind: "delegate" }),
  );
  const first = f.ask(child.id, "first");
  await expect
    .poll(() => f.runtime.runPromise(f.permission.list()))
    .toHaveLength(1);
  const parent = await f.observe(root.id);
  expect(requests(parent)).toEqual([{ id: first.id, sessionID: child.id }]);

  for (const response of f.connections) response.destroy();
  await expect.poll(() => f.connections.size).toBe(0);
  await first.cancel();
  const second = f.ask(child.id, "second");
  await expect
    .poll(() => f.runtime.runPromise(f.permission.list()))
    .toHaveLength(1);
  await expect
    .poll(() => requests(parent), { timeout: 7_000 })
    .toEqual([{ id: second.id, sessionID: child.id }]);
  await parent.replyPermission(second.id, "once");
  expect(Exit.isSuccess(await second.result)).toBe(true);
  await expect.poll(() => requests(parent)).toEqual([]);
}, 10_000);
