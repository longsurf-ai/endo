// Purpose: Locks resolve ordering, lazy Resource transitions, and atomic composition at the runner boundary.

import { Database } from "@openchart/server/db";
import {
  agentScheduleResource,
  type AgentScheduleId,
} from "@openchart/server/resources/agent-schedule";
import { agentScheduleOccurrenceResource } from "@openchart/server/resources/agent-schedule-occurrence";
import { Deferred, Effect, Exit, Fiber, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { STRICT_PARSE_OPTIONS } from "./definition";
import { RevisionConflict } from "./errors";
import * as Transition from "./transition";
import { run } from "./transactor";

let runtime: ManagedRuntime.ManagedRuntime<Database.Service, never>;
let db: Database.Client;
let onCommitted: ReturnType<typeof vi.fn<Database.OnCommitted>>;

beforeEach(async () => {
  onCommitted = vi.fn<Database.OnCommitted>(() => Effect.void);
  runtime = ManagedRuntime.make(Database.layer(":memory:", onCommitted));
  db = (await runtime.runPromise(Database.Service)).db;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.dispose();
});

/** A second Resource written in the same transaction, referencing its Schedule. */
function occurrence(scheduleId: AgentScheduleId) {
  return agentScheduleOccurrenceResource.transitions.ensureOccurrence({
    scheduleId,
    fireAt: 1,
    agentRunId: null,
    sessionId: null,
  });
}

function schedule(name: string) {
  return agentScheduleResource.transitions.create(
    Schema.decodeUnknownSync(
      agentScheduleResource.createSchema,
      STRICT_PARSE_OPTIONS,
    )({
      name,
      enabled: false,
      target: {
        kind: "agent_prompt",
        prompt: {
          agent: "analyst",
          model: { providerID: "codex", modelID: "tier1" },
          parts: [{ type: "text", text: "Research" }],
        },
      },
      recurrence: { kind: "once", fireAt: "2090-01-01T00:00:00.000Z" },
    }),
  );
}

async function expectNoResources() {
  expect(
    await runtime.runPromise(
      run(agentScheduleOccurrenceResource.transitions.list()),
    ),
  ).toEqual({ items: [], nextCursor: null });
  expect(
    await runtime.runPromise(run(agentScheduleResource.transitions.list())),
  ).toEqual({ items: [], nextCursor: null });
  expect(onCommitted).not.toHaveBeenCalled();
}

test("constructs intrinsic transitions without IO or ids and creates a fresh id per execution", async () => {
  const createId = vi.spyOn(agentScheduleResource.id, "create");
  const insert = vi.spyOn(agentScheduleResource.store, "insert");
  const transaction = vi.spyOn(db, "transaction");
  const create = schedule("Deferred");
  const id = agentScheduleResource.id.make("ags_missing");
  agentScheduleResource.transitions.get(id);
  agentScheduleResource.transitions.list();
  agentScheduleResource.transitions.patch({
    id,
    expectedRevision: 1,
    operations: [{ op: "replace", path: "/name", value: "Deferred" }],
  });
  agentScheduleResource.transitions.remove(id);
  const program = run(create);

  expect(createId).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();

  const first = await runtime.runPromise(program);
  const second = await runtime.runPromise(program);
  expect(first.id).not.toBe(second.id);
  expect(first.revision).toBe(1);
  expect(second.revision).toBe(1);
  expect(createId).toHaveBeenCalledTimes(2);
  expect(transaction).toHaveBeenCalledTimes(2);
});

test("finishes resolution before acquiring a transaction and passes its result to apply", async () => {
  const transaction = vi.spyOn(db, "transaction");
  const created = await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const transition = Transition.make({
          resolve: Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            return { name: "Resolved" };
          }),
          apply: (tx, resolved) => schedule(resolved.name).apply(tx),
        });
        const fiber = yield* run(transition).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        expect(transaction).not.toHaveBeenCalled();
        // A pending resolver must not hold SQLite's transaction lock.
        yield* run(schedule("While resolving"));
        yield* Deferred.succeed(finish, undefined);
        return yield* Fiber.join(fiber);
      }),
    ),
  );
  expect(created.name).toBe("Resolved");
  expect(transaction).toHaveBeenCalledTimes(2);
});

test("resolver failure never starts a transaction or applies the operation", async () => {
  const failure = new Error("Resolver unavailable");
  const transaction = vi.spyOn(db, "transaction");
  const apply = vi.fn(() => Effect.succeed("must not apply"));
  const transition = Transition.make({ resolve: Effect.fail(failure), apply });

  expect(await runtime.runPromise(Effect.flip(run(transition)))).toBe(failure);
  expect(transaction).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(onCommitted).not.toHaveBeenCalled();
});

test("composes resolved transitions into one transaction and publishes only the final revisions", async () => {
  const transaction = vi.spyOn(db, "transaction");
  const order: string[] = [];
  const first = Transition.make({
    resolve: Effect.sync(() => {
      order.push("resolve schedule");
      return "Schedule";
    }),
    apply: (tx, name) => schedule(name).apply(tx),
  });
  // The Occurrence references the created Schedule, so only its resolver runs early.
  const resolveOccurrence = Effect.sync(() => {
    order.push("resolve occurrence");
  });
  const combined = Transition.make({
    resolve: Effect.all({ first: first.resolve, second: resolveOccurrence }),
    apply: (tx, resolved) =>
      Effect.gen(function* () {
        expect(order).toEqual(["resolve schedule", "resolve occurrence"]);
        const created = yield* first.apply(tx, resolved.first);
        const accepted = yield* occurrence(created.id).apply(tx, undefined);
        const updated = yield* agentScheduleResource.transitions
          .patch({
            id: created.id,
            expectedRevision: created.revision,
            operations: [{ op: "replace", path: "/name", value: "Renamed" }],
          })
          .apply(tx);
        const read = yield* agentScheduleResource.transitions
          .get(created.id)
          .apply(tx);
        expect(read).toEqual(updated);
        expect(onCommitted).not.toHaveBeenCalled();
        return { updated, accepted };
      }),
  });

  const { updated, accepted } = await runtime.runPromise(run(combined));
  expect(updated.revision).toBe(2);
  expect(accepted.scheduleId).toBe(updated.id);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(onCommitted).toHaveBeenCalledExactlyOnceWith([
    { table: "agent_schedule", id: updated.id, revision: 2 },
    { table: "agent_schedule_occurrence", id: accepted.id, revision: 1 },
  ]);
});

test("a later revision conflict rolls back every earlier transition and its notifications", async () => {
  const combined = Transition.from((tx) =>
    Effect.gen(function* () {
      const created = yield* schedule("Rollback").apply(tx);
      yield* occurrence(created.id).apply(tx, undefined);
      yield* agentScheduleResource.transitions
        .patch({
          id: created.id,
          expectedRevision: created.revision + 1,
          operations: [{ op: "replace", path: "/name", value: "Never saved" }],
        })
        .apply(tx);
    }),
  );

  const failure = await runtime.runPromise(Effect.flip(run(combined)));
  expect(failure).toBeInstanceOf(RevisionConflict);
  await expectNoResources();
});

test("a stored-entity decoding defect rolls back the composed transaction", async () => {
  const insert = agentScheduleOccurrenceResource.store.insert;
  const corruptInsert = vi
    .spyOn(agentScheduleOccurrenceResource.store, "insert")
    .mockImplementation((tx, input) =>
      insert(tx, input).pipe(
        Effect.map((row) => ({ ...row, body: { invalid: true } })),
      ),
    );
  const combined = Transition.from((tx) =>
    Effect.gen(function* () {
      const created = yield* schedule("Rollback").apply(tx);
      yield* occurrence(created.id).apply(tx, undefined);
    }),
  );

  const result = await runtime.runPromise(Effect.exit(run(combined)));
  expect(corruptInsert).toHaveBeenCalledTimes(1);
  expect(Exit.hasDies(result)).toBe(true);
  await expectNoResources();
});

test("interruption during apply rolls back all composed writes", async () => {
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const written = yield* Deferred.make<void>();
        const combined = Transition.from((tx) =>
          Effect.gen(function* () {
            const created = yield* schedule("Interrupted").apply(tx);
            yield* occurrence(created.id).apply(tx, undefined);
            yield* Deferred.succeed(written, undefined);
            yield* Effect.never;
          }),
        );
        const fiber = yield* run(combined).pipe(Effect.forkScoped);
        yield* Deferred.await(written);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
  await expectNoResources();
});
