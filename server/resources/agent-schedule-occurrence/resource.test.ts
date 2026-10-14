// Purpose: Verifies backend Occurrence CRUD, Session projection, pagination, and Schedule-only cascades.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { router } from "@openchart/server";
import { agentRun, agentSessions } from "@openchart/server/agent/schema";
import { makeRuntime } from "@openchart/server/runtime";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Transactor, Transition } from "@openchart/server/lib/resource";
import { ResourceChanged } from "@openchart/server/lib/resource/events";
import { ENVELOPE_FIELD_NAMES } from "@openchart/server/lib/resource/envelope";
import { Effect, Struct } from "effect";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";

import { agentScheduleOccurrenceResource } from "./resource";
import { agentScheduleOccurrenceStore } from "./store";

const prompt = {
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text" as const, text: "Research." }],
};
const schedule = {
  name: "Research",
  target: { kind: "agent_prompt" as const, prompt },
  recurrence: { kind: "once" as const, fireAt: "2090-01-01T00:00:00.000Z" },
};
let runtime: ReturnType<typeof makeRuntime>;
let caller: ReturnType<typeof router.createCaller>;
let sessionId: SessionId;
beforeEach(async () => {
  runtime = makeRuntime({ home: temporaryHome(), databasePath: ":memory:" });
  caller = router.createCaller({ runtime });
  sessionId = SessionId.create();
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(agentSessions).values({
            kind: "chat",
            id: sessionId,
            title: "Scheduled research",
          });
          yield* tx.insert(agentRun).values(
            Array.from({ length: 4 }, (_, i) => ({
              id: `agr_${i}`,
              sessionId,
              sessionIntentId: `intent-${i}`,
              input: prompt,
              queuePosition: i,
              createdAt: 100,
            })),
          );
        }),
      );
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.dispose();
});

test("backend write types reject partial provenance and unrelated values", () => {
  type Body = Parameters<typeof agentScheduleOccurrenceStore.save>[2]["body"];
  type Create = Parameters<
    typeof agentScheduleOccurrenceResource.transitions.create
  >[0];
  type Ensure = Parameters<
    typeof agentScheduleOccurrenceResource.transitions.ensureOccurrence
  >[0];
  type PartialProvenance = { agentRunId: string; fireAt: number };
  expectTypeOf<PartialProvenance>().not.toExtend<Body>();
  expectTypeOf<PartialProvenance>().not.toExtend<Create>();
  expectTypeOf<PartialProvenance>().not.toExtend<Ensure>();
  expectTypeOf({}).not.toExtend<Ensure>();
  expectTypeOf<Ensure>().toExtend<
    typeof agentScheduleOccurrenceResource.body.Type
  >();
  expectTypeOf<
    typeof agentScheduleOccurrenceResource.body.Type
  >().toExtend<Ensure>();
  expectTypeOf<{ typo: boolean }>().not.toExtend<Body>();
  expectTypeOf<{ typo: boolean }>().not.toExtend<Create>();
  expectTypeOf<string>().not.toExtend<Body>();
  expectTypeOf({}).toExtend<Body>();
  expectTypeOf<
    typeof agentScheduleOccurrenceResource.body.Type
  >().toExtend<Body>();
});

test("named acceptance is lazy and replays the same Occurrence without another write or invalidation", async () => {
  const parent = await caller.resources.agent_schedule.create(schedule);
  const body = {
    scheduleId: parent.id,
    agentRunId: "agr_0",
    sessionId,
    fireAt: 1,
  };
  const createId = vi.spyOn(agentScheduleOccurrenceResource.id, "create");
  const insert = vi.spyOn(agentScheduleOccurrenceStore, "insert");
  const { db } = await runtime.runPromise(Database.Service);
  const transaction = vi.spyOn(db, "transaction");
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  const operation =
    agentScheduleOccurrenceResource.transitions.ensureOccurrence(body);

  expect(createId).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();

  const created = await runtime.runPromise(Transactor.run(operation));
  const replayed = await runtime.runPromise(Transactor.run(operation));

  expect(created).toMatchObject({ ...body, revision: 1 });
  expect(created.id).toMatch(/^aso_/);
  expect(replayed).toEqual(created);
  expect(createId).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(transaction).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledExactlyOnceWith(ResourceChanged, {
    resource: "agent_schedule_occurrence",
    id: created.id,
    revision: 1,
  });
});

test("acceptance finds later pages before replaying or creating a fire in one transaction", async () => {
  const parent = await caller.resources.agent_schedule.create(schedule);
  const { db } = await runtime.runPromise(Database.Service);
  const history = Array.from({ length: 101 }, (_, i) => i);
  await runtime.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(agentRun).values(
          history.map((i) => ({
            id: `agr_history_${i}`,
            sessionId,
            sessionIntentId: `history-${i}`,
            input: prompt,
            queuePosition: i + 4,
            createdAt: 100,
          })),
        );
        yield* Effect.forEach(history, (i) =>
          agentScheduleOccurrenceResource.transitions
            .create({
              scheduleId: parent.id,
              agentRunId: `agr_history_${i}`,
              sessionId,
              fireAt: i,
            })
            .apply(tx),
        );
      }),
    ),
  );
  const first = await caller.resources.agent_schedule_occurrence.list({
    filter: { scheduleId: parent.id },
    limit: 100,
  });
  expect(first.nextCursor).not.toBeNull();
  const second = await caller.resources.agent_schedule_occurrence.list({
    filter: { scheduleId: parent.id },
    limit: 100,
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(1);
  const stored = second.items[0]!;
  const body = Struct.omit(stored, ENVELOPE_FIELD_NAMES);
  const insert = vi.spyOn(agentScheduleOccurrenceStore, "insert");
  const transaction = vi.spyOn(db, "transaction");
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  const ensure = (input: typeof body) =>
    runtime.runPromise(
      Transactor.run(
        agentScheduleOccurrenceResource.transitions.ensureOccurrence(input),
      ),
    );

  expect(await ensure(body)).toEqual(stored);
  await expect(ensure({ ...body, agentRunId: "agr_0" })).rejects.toThrow(
    "A scheduled fire must retain its accepted Run and Session",
  );
  expect(transaction).toHaveBeenCalledTimes(2);
  expect(insert).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();

  const next = { ...body, agentRunId: "agr_0", fireAt: 101 };
  expect(await ensure(next)).toMatchObject({ ...next, revision: 1 });
  expect(transaction).toHaveBeenCalledTimes(3);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("named acceptance rejects conflicting replay provenance and rolls back mismatched new Session projections", async () => {
  const parent = await caller.resources.agent_schedule.create(schedule);
  const body = {
    scheduleId: parent.id,
    agentRunId: "agr_0",
    sessionId,
    fireAt: 1,
  };
  const created = await runtime.runPromise(
    Transactor.run(
      agentScheduleOccurrenceResource.transitions.ensureOccurrence(body),
    ),
  );
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  for (const invalid of [
    { ...body, agentRunId: "agr_1" },
    { ...body, sessionId: SessionId.create() },
  ]) {
    await expect(
      runtime.runPromise(
        Transactor.run(
          agentScheduleOccurrenceResource.transitions.ensureOccurrence(invalid),
        ),
      ),
    ).rejects.toThrow(
      "A scheduled fire must retain its accepted Run and Session",
    );
  }
  await expect(
    runtime.runPromise(
      Transactor.run(
        agentScheduleOccurrenceResource.transitions.ensureOccurrence({
          ...body,
          agentRunId: "agr_1",
          fireAt: 2,
          sessionId: SessionId.create(),
        }),
      ),
    ),
  ).rejects.toBeDefined();
  expect(await caller.resources.agent_schedule_occurrence.list()).toEqual({
    items: [created],
    nextCursor: null,
  });
  expect(publish).not.toHaveBeenCalled();
});

test("named acceptance rolls back and publishes nothing when the stored entity fails decoding", async () => {
  const parent = await caller.resources.agent_schedule.create(schedule);
  const insert = agentScheduleOccurrenceStore.insert;
  vi.spyOn(agentScheduleOccurrenceStore, "insert").mockImplementation(
    (tx, input) =>
      insert(tx, input).pipe(Effect.map((row) => ({ ...row, revision: 0 }))),
  );
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");

  await expect(
    runtime.runPromise(
      Transactor.run(
        agentScheduleOccurrenceResource.transitions.ensureOccurrence({
          scheduleId: parent.id,
          agentRunId: "agr_0",
          sessionId,
          fireAt: 1,
        }),
      ),
    ),
  ).rejects.toThrow("failed its entity schema");
  expect(await caller.resources.agent_schedule_occurrence.list()).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(publish).not.toHaveBeenCalled();
});

test("backend creation and save use the normal transaction path, while reads project the Run Session", async () => {
  const parent = await caller.resources.agent_schedule.create(schedule);
  const body = {
    scheduleId: parent.id,
    agentRunId: "agr_0",
    sessionId,
    fireAt: 1,
  };
  const created = await runtime.runPromise(
    Transactor.run(agentScheduleOccurrenceResource.transitions.create(body)),
  );
  expect(created).toMatchObject({ ...body, revision: 1 });
  expect(created.id).toMatch(/^aso_/);
  expect(
    await caller.resources.agent_schedule_occurrence.get({ id: created.id }),
  ).toEqual(created);
  const currentBody = Struct.omit(created, ENVELOPE_FIELD_NAMES);
  await runtime.runPromise(
    Transactor.run(
      Transition.from((tx) =>
        agentScheduleOccurrenceStore.save(tx, created.id, {
          revision: 2,
          body: { ...currentBody, agentRunId: "agr_1", fireAt: 2 },
        }),
      ),
    ),
  );
  const changed = await caller.resources.agent_schedule_occurrence.get({
    id: created.id,
  });
  expect(changed).toMatchObject({
    agentRunId: "agr_1",
    fireAt: 2,
    sessionId,
    revision: 2,
    createdAt: created.createdAt,
  });
  await runtime.runPromise(
    Transactor.run(
      Transition.from((tx) =>
        agentScheduleOccurrenceStore.save(tx, created.id, {
          revision: 3,
          body: {},
        }),
      ),
    ),
  );
  expect(
    await caller.resources.agent_schedule_occurrence.get({ id: created.id }),
  ).toMatchObject({ ...changed, revision: 3, updatedAt: expect.any(Number) });
  await runtime.runPromise(
    Transactor.run(
      agentScheduleOccurrenceResource.transitions.remove(created.id),
    ),
  );
  expect(await caller.resources.agent_schedule_occurrence.list()).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(await caller.resources.agent_schedule.get({ id: parent.id })).toEqual(
    parent,
  );
});

test("filters and paginates Occurrences, and Schedule deletion preserves Runs and Sessions", async () => {
  const first = await caller.resources.agent_schedule.create(schedule);
  const second = await caller.resources.agent_schedule.create({
    ...schedule,
    name: "Second",
  });
  const occurrences = [];
  for (let i = 0; i < 3; i++) {
    occurrences.push(
      await runtime.runPromise(
        Transactor.run(
          agentScheduleOccurrenceResource.transitions.create({
            scheduleId: i === 1 ? second.id : first.id,
            agentRunId: `agr_${i}`,
            sessionId,
            fireAt: i,
          }),
        ),
      ),
    );
  }
  const a = await caller.resources.agent_schedule_occurrence.list({
    filter: { scheduleId: first.id },
    limit: 1,
  });
  expect(a.items).toEqual([occurrences[0]]);
  expect(a.nextCursor).not.toBeNull();
  const b = await caller.resources.agent_schedule_occurrence.list({
    filter: { scheduleId: first.id },
    limit: 1,
    cursor: a.nextCursor!,
  });
  expect(b).toEqual({ items: [occurrences[2]], nextCursor: null });
  const history = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        return {
          runs: yield* db.select().from(agentRun),
          sessions: yield* db.select().from(agentSessions),
        };
      }),
    );
  const before = await history();
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  await caller.resources.agent_schedule.delete({ id: first.id });
  expect(await history()).toEqual(before);
  expect(await caller.resources.agent_schedule_occurrence.list()).toEqual({
    items: [occurrences[1]],
    nextCursor: null,
  });
  expect(
    publish.mock.calls.map(([schema, value]) => ({ schema, value })),
  ).toEqual(
    expect.arrayContaining([
      {
        schema: ResourceChanged,
        value: { resource: "agent_schedule", id: first.id, revision: 1 },
      },
      ...[occurrences[0]!, occurrences[2]!].map((row) => ({
        schema: ResourceChanged,
        value: {
          resource: "agent_schedule_occurrence",
          id: row.id,
          revision: 1,
        },
      })),
    ]),
  );
  expect(publish).toHaveBeenCalledTimes(3);
});

test("rejects missing provenance, mismatched projections, and duplicate fire/run identities atomically", async () => {
  const parent = await caller.resources.agent_schedule.create(schedule);
  const body = {
    scheduleId: parent.id,
    agentRunId: "agr_0",
    sessionId,
    fireAt: 1,
  };
  const created = await runtime.runPromise(
    Transactor.run(agentScheduleOccurrenceResource.transitions.create(body)),
  );
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  for (const invalid of [
    {},
    { ...body, agentRunId: "agr_1", fireAt: 2, sessionId: SessionId.create() },
    { ...body, agentRunId: "agr_1" },
    { ...body, fireAt: 2 },
    { ...body, scheduleId: "ags_missing", agentRunId: "agr_1" },
    { ...body, agentRunId: "agr_missing" },
  ]) {
    await expect(
      runtime.runPromise(
        Transactor.run(
          agentScheduleOccurrenceResource.transitions.create(invalid),
        ),
      ),
    ).rejects.toBeDefined();
  }
  expect(await caller.resources.agent_schedule_occurrence.list()).toEqual({
    items: [created],
    nextCursor: null,
  });
  expect(publish).not.toHaveBeenCalled();
});
