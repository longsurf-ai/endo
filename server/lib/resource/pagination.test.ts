// Purpose: Verifies bounded Resource pagination through the application router and real Stores.

import { router } from "@openchart/server";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime } from "@openchart/server/runtime";
import { Database } from "@openchart/server/db";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { agentScheduleOccurrenceResource } from "@openchart/server/resources/agent-schedule-occurrence";
import { agentSchedules } from "@openchart/server/resources/agent-schedule/schema";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListPosition,
  listInputSchema,
  listPage,
} from "./pagination";
import * as Transactor from "./transactor";
import * as Transition from "./transition";

type Schedule = typeof agentScheduleResource.entity.Type;
const target: Schedule["target"] = {
  kind: "agent_prompt",
  prompt: {
    agent: "analyst",
    model: { providerID: "codex", modelID: "tier1" },
    parts: [{ type: "text", text: "Research" }],
  },
};
const recurrence: Schedule["recurrence"] = {
  kind: "once",
  fireAt: "2090-01-01T00:00:00.000Z",
};
/** A complete disabled Schedule row inserted directly to control its timestamps. */
const row = (id: string, createdAt: number, updatedAt: number) => ({
  id,
  name: id,
  enabled: false,
  target,
  recurrence,
  nextFireAt: Date.parse("2090-01-01T00:00:00.000Z"),
  createdAt,
  updatedAt,
});

let runtime: ReturnType<typeof makeRuntime>;
let caller: ReturnType<typeof router.createCaller>;

beforeEach(() => {
  runtime = makeRuntime({ home: temporaryHome(), databasePath: ":memory:" });
  caller = router.createCaller({ runtime });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.dispose();
});

test.each(["createdAt", "updatedAt"] as const)(
  "%s orders the complete Resource directory before paging and retains deleted cursor positions",
  async (orderBy) => {
    const ids = Array.from(
      { length: 33 },
      (_, index) => `ags_sort_${String(index).padStart(3, "0")}`,
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db.transaction((tx) =>
          tx
            .insert(agentSchedules)
            .values(
              ids.map((id, index) =>
                row(
                  id,
                  10 + Math.floor(index / 2),
                  100 - Math.floor(index / 2),
                ),
              ),
            ),
        );
      }),
    );
    const sorted = [...ids].sort((a, b) => {
      const left = ids.indexOf(a),
        right = ids.indexOf(b);
      const delta = Math.floor(right / 2) - Math.floor(left / 2);
      return (orderBy === "createdAt" ? delta : -delta) || b.localeCompare(a);
    });
    const first = await caller.resources.agent_schedule.list({
      limit: 15,
      order: "desc",
      orderBy,
    });
    expect(first.items.map((row) => row.id)).toEqual(sorted.slice(0, 15));
    await caller.resources.agent_schedule.delete({
      id: first.items.at(-1)!.id,
    });
    const idsAfter: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await caller.resources.agent_schedule.list({
        limit: 7,
        order: "desc",
        orderBy,
        cursor,
      });
      idsAfter.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    }
    expect(idsAfter).toEqual(sorted.slice(15));
  },
);

test.each([0, 100, 205])(
  "listAll reads %i entities in order inside the caller transaction",
  async (count) => {
    const ids = Array.from(
      { length: count },
      (_, i) => `ags_${String(i).padStart(3, "0")}`,
    );
    const entities = await runtime.runPromise(
      Transactor.run(
        Transition.from((tx) =>
          Effect.gen(function* () {
            if (ids.length) {
              yield* tx
                .insert(agentSchedules)
                .values(
                  [...ids]
                    .reverse()
                    .map((id, i) => row(id, i < count - 100 ? 200 : 100, 200)),
                );
            }
            // Uncommitted writes must be visible throughout the full traversal.
            return yield* agentScheduleResource.transitions.listAll().apply(tx);
          }),
        ),
      ),
    );
    expect(entities.map((entity) => entity.id)).toEqual(ids);
    expect(entities.map((entity) => entity.name)).toEqual(ids);
    expect(entities.every((entity) => !entity.enabled)).toBe(true);
  },
);

test("uses a bounded default and stable cursors through ties, edits, and deleted anchors", async () => {
  const ids = Array.from(
    { length: 103 },
    (_, i) => `ags_${String(i).padStart(3, "0")}`,
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db.transaction((tx) =>
        tx
          .insert(agentSchedules)
          .values(ids.map((id, i) => row(id, i < 100 ? 100 : 200, 200))),
      );
    }),
  );
  const list = vi.spyOn(agentScheduleResource.store, "list");
  const first = await caller.resources.agent_schedule.list();
  expect(first.items.map((item) => item.id)).toEqual(
    ids.slice(0, DEFAULT_PAGE_SIZE),
  );
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(list.mock.calls[0]?.[2]).toEqual({
    limit: DEFAULT_PAGE_SIZE + 1,
    cursor: undefined,
  });
  const anchor = first.items.at(-1)!;
  await caller.resources.agent_schedule.delete({ id: anchor.id });
  await caller.resources.agent_schedule.delete({ id: first.items[0]!.id });
  await caller.resources.agent_schedule.patch({
    id: first.items[1]!.id,
    expectedRevision: 1,
    operations: [{ op: "replace", path: "/name", value: "renamed" }],
  });
  const remaining: string[] = [];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await caller.resources.agent_schedule.list({
      limit: 17,
      cursor,
    });
    expect(page.items.length).toBeLessThanOrEqual(17);
    remaining.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  }
  expect(remaining).toEqual(ids.slice(DEFAULT_PAGE_SIZE));
  expect(list.mock.calls[1]?.[2]).toEqual({
    limit: 18,
    cursor: { createdAt: 100, updatedAt: 200, id: ids[49] },
  });
  expect(
    await caller.resources.agent_schedule.list({
      limit: MAX_PAGE_SIZE,
      cursor: Buffer.from(
        JSON.stringify({ createdAt: 200, updatedAt: 200, id: ids[102] }),
      ).toString("base64url"),
    }),
  ).toEqual({ items: [], nextCursor: null });
});

test("a descending window walks newest first with stable cursors through ties and deleted anchors", async () => {
  const ids = Array.from(
    { length: 103 },
    (_, i) => `ags_${String(i).padStart(3, "0")}`,
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db.transaction((tx) =>
        tx
          .insert(agentSchedules)
          .values(ids.map((id, i) => row(id, i < 100 ? 100 : 200, 200))),
      );
    }),
  );
  const readPage = (cursor?: ListPosition) =>
    runtime
      .runPromise(
        Transactor.run(
          Transition.from((tx) =>
            agentScheduleResource.store.list(
              tx,
              {},
              { limit: 18, cursor, order: "desc" },
            ),
          ),
        ),
      )
      .then((rows) => listPage(rows, 17));
  const first = await readPage();
  const newestFirst = [...ids].reverse();
  expect(first.items.map((row) => row.id)).toEqual(newestFirst.slice(0, 17));
  // The cursor keeps its ascending format and survives deletion of its row.
  expect(first.nextCursor).toEqual({
    createdAt: 100,
    updatedAt: 200,
    id: newestFirst[16],
  });
  await caller.resources.agent_schedule.delete({ id: newestFirst[16]! });
  const remaining: string[] = [];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await readPage(cursor);
    expect(page.items.length).toBeLessThanOrEqual(17);
    remaining.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
  }
  expect(remaining).toEqual(newestFirst.slice(17));
  // The public list transition forwards the order to the Store.
  const throughRouter: string[] = [];
  let token: string | undefined;
  do {
    const page = await caller.resources.agent_schedule.list({
      order: "desc",
      limit: 17,
      ...(token ? { cursor: token } : {}),
    });
    throughRouter.push(...page.items.map((item) => item.id));
    token = page.nextCursor ?? undefined;
  } while (token);
  expect(throughRouter).toEqual(
    newestFirst.filter((id) => id !== newestFirst[16]),
  );
  // The same position continues forward when the direction is ascending.
  expect(
    await caller.resources.agent_schedule.list({
      limit: MAX_PAGE_SIZE,
      cursor: Buffer.from(JSON.stringify(first.nextCursor)).toString(
        "base64url",
      ),
    }),
  ).toMatchObject({ items: ids.slice(87).map((id) => ({ id })) });
});

test("list input accepts only asc or desc as its order", () => {
  const decode = Schema.decodeUnknownSync(listInputSchema(Schema.Struct({})));
  expect(decode({})).toEqual({});
  expect(decode({ order: "asc", limit: 1 })).toEqual({
    order: "asc",
    limit: 1,
  });
  expect(decode({ order: "desc" })).toEqual({ order: "desc" });
  for (const order of ["newest", "DESC", "", null, 1]) {
    expect(() => decode({ order })).toThrow();
  }
});

test("rejects invalid bounds, cursors, and filters before Store access", async () => {
  const list = vi.spyOn(agentScheduleResource.store, "list");
  for (const input of [
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: MAX_PAGE_SIZE + 1 },
    { cursor: { createdAt: 0, updatedAt: 0, id: "ags_a" } },
    { cursor: null },
    { cursor: "" },
    { cursor: "not a base64url token!" },
    { cursor: Buffer.from("{").toString("base64url") },
    ...[
      null,
      [],
      {},
      { createdAt: -1, updatedAt: 0, id: "ags_a" },
      { createdAt: 0, updatedAt: 0 },
      { createdAt: 0, updatedAt: 0, id: "" },
      { createdAt: 0.5, updatedAt: 0, id: "ags_a" },
      { createdAt: 0, updatedAt: -1, id: "ags_a" },
      { createdAt: 0, updatedAt: 0.5, id: "ags_a" },
      { createdAt: 0, updatedAt: 0, id: "ags_a", extra: true },
    ].map((position) => ({
      cursor: Buffer.from(JSON.stringify(position)).toString("base64url"),
    })),
    { filter: { name: "hidden" } },
    { order: "newest" },
    { order: null },
    { orderBy: "name" },
    { orderBy: null },
    { extra: true },
  ]) {
    await expect(
      caller.resources.agent_schedule.list(input as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(list).not.toHaveBeenCalled();
});

test("paginates existing joined Resources and applies filters before the row limit", async () => {
  const first = await caller.resources.agent_schedule.create({
    name: "first",
    target,
    recurrence,
  });
  const second = await caller.resources.agent_schedule.create({
    name: "second",
    target,
    recurrence,
  });
  const accept = (scheduleId: typeof first.id, fireAt: number) =>
    runtime.runPromise(
      Transactor.run(
        agentScheduleOccurrenceResource.transitions.ensureOccurrence({
          scheduleId,
          fireAt,
          agentRunId: null,
          sessionId: null,
        }),
      ),
    );
  await accept(second.id, 1);
  const occurrences = [await accept(first.id, 2), await accept(first.id, 3)];
  const all = await caller.resources.agent_schedule_occurrence.list({
    limit: 1,
  });
  expect(all.nextCursor).not.toBeNull();
  const next = await caller.resources.agent_schedule_occurrence.list({
    limit: 1,
    cursor: all.nextCursor!,
  });
  expect(next.items).toEqual([occurrences[0]]);
  const filteredIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await caller.resources.agent_schedule_occurrence.list({
      filter: { scheduleId: first.id },
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    filteredIds.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(filteredIds).toEqual(occurrences.map((item) => item.id));
  expect(
    await runtime.runPromise(
      Transactor.run(
        agentScheduleOccurrenceResource.transitions.listAll({
          filter: { scheduleId: first.id },
        }),
      ),
    ),
  ).toEqual(occurrences);
  expect(
    (await caller.resources.agent_schedule.list({ limit: 1 })).items,
  ).toEqual([first]);
});
