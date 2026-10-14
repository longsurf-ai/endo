// Purpose: Proves committed-change callbacks include cascades and exclude rolled-back or uncommitted writes.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber, ManagedRuntime } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Database } from "@openchart/server/db";

function makeRuntime(onCommitted: Database.OnCommitted, filename = ":memory:") {
  return ManagedRuntime.make(Database.layer(filename, onCommitted));
}

let runtime: ReturnType<typeof makeRuntime>;
let db: Database.Client;
let onCommitted: ReturnType<typeof vi.fn<Database.OnCommitted>>;

beforeEach(async () => {
  onCommitted = vi.fn<Database.OnCommitted>(() => Effect.void);
  runtime = makeRuntime(onCommitted);
  db = (await runtime.runPromise(Database.Service)).db;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.dispose();
});

function changes() {
  return onCommitted.mock.calls.flatMap(([batch]) => batch);
}

const target = JSON.stringify({
  kind: "agent_prompt",
  prompt: {
    agent: "analyst",
    model: { providerID: "codex", modelID: "tier1" },
    parts: [{ type: "text", text: "Example" }],
  },
});
const recurrence = JSON.stringify({
  kind: "once",
  fireAt: "2090-01-01T00:00:00.000Z",
});

/** Raw SQL for one complete Schedule root row; Occurrences cascade from it. */
function insertSchedule(id: string) {
  return sql`INSERT INTO agent_schedule (id, name, target_json, recurrence, next_fire_at)
    VALUES (${id}, 'Example', ${target}, ${recurrence}, 3786912000000)`;
}

async function expectEmptyBuffer() {
  expect(
    await runtime.runPromise(db.all(sql`SELECT * FROM resource_event_buffer`)),
  ).toEqual([]);
  expect(
    await runtime.runPromise(
      db.all(sql`SELECT * FROM resource_event_transaction`),
    ),
  ).toEqual([]);
}

test("detects SQL writes without a Store and coalesces revisions after commit", async () => {
  await runtime.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run(insertSchedule("ags_one"));
        expect(changes()).toEqual([]);
      }),
    ),
  );
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_one", revision: 1 },
  ]);
  onCommitted.mockClear();

  await runtime.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run(sql`UPDATE agent_schedule SET revision = 2`);
        yield* tx.run(sql`UPDATE agent_schedule SET revision = 3`);
        expect(changes()).toEqual([]);
      }),
    ),
  );
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_one", revision: 3 },
  ]);
  onCommitted.mockClear();

  await runtime.runPromise(
    db.transaction((tx) => tx.run(sql`DELETE FROM agent_schedule`)),
  );
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_one", revision: 3 },
  ]);
  await expectEmptyBuffer();
});

test("captures only affected Resource roots on cascade", async () => {
  await runtime.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run(insertSchedule("ags_one"));
        yield* tx.run(insertSchedule("ags_other"));
        yield* tx.run(sql`
          INSERT INTO agent_schedule_occurrence (id, schedule_id, fire_at, revision) VALUES
            ('aso_a', 'ags_one', 1, 2),
            ('aso_other', 'ags_other', 1, 1)
        `);
      }),
    ),
  );
  onCommitted.mockClear();
  const remove = db.transaction((tx) =>
    tx.run(sql`DELETE FROM agent_schedule WHERE id = 'ags_one'`),
  );

  const rolledBack = await runtime.runPromise(
    Effect.exit(
      db.transaction(() =>
        remove.pipe(Effect.andThen(Effect.fail("cancel deletion"))),
      ),
    ),
  );
  expect(Exit.isFailure(rolledBack)).toBe(true);
  expect(changes()).toEqual([]);
  await expectEmptyBuffer();

  await runtime.runPromise(remove);
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_one", revision: 1 },
    { table: "agent_schedule_occurrence", id: "aso_a", revision: 2 },
  ]);
  expect(
    await runtime.runPromise(
      db.all(sql`SELECT id FROM agent_schedule_occurrence`),
    ),
  ).toEqual([{ id: "aso_other" }]);
  await expectEmptyBuffer();
});

test("savepoint rollback restores the buffered revision and outer rollback discards nested success", async () => {
  await runtime.runPromise(
    db.transaction((tx) => tx.run(insertSchedule("ags_one"))),
  );
  onCommitted.mockClear();

  await runtime.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run(sql`UPDATE agent_schedule SET revision = 2`);
        const inner = yield* Effect.exit(
          tx.transaction((nested) =>
            nested
              .run(sql`UPDATE agent_schedule SET revision = 3`)
              .pipe(Effect.andThen(Effect.fail("cancel savepoint"))),
          ),
        );
        expect(Exit.isFailure(inner)).toBe(true);
        expect(changes()).toEqual([]);
      }),
    ),
  );
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_one", revision: 2 },
  ]);
  onCommitted.mockClear();

  await runtime.runPromise(
    Effect.exit(
      db.transaction((tx) =>
        tx
          .transaction((nested) =>
            nested.run(sql`UPDATE agent_schedule SET revision = 4`),
          )
          .pipe(
            Effect.tap(() => Effect.sync(() => expect(changes()).toEqual([]))),
            Effect.andThen(Effect.fail("cancel outer transaction")),
          ),
      ),
    ),
  );
  expect(changes()).toEqual([]);
  expect(
    await runtime.runPromise(db.all(sql`SELECT revision FROM agent_schedule`)),
  ).toEqual([{ revision: 2 }]);
  await expectEmptyBuffer();
});

test("serializes concurrent transactions without leaking rolled-back changes", async () => {
  const result = await runtime.runPromise(
    Effect.all(
      [
        db.transaction((tx) =>
          tx
            .run(insertSchedule("ags_committed"))
            .pipe(Effect.andThen(Effect.yieldNow)),
        ),
        Effect.exit(
          db.transaction((tx) =>
            tx
              .run(insertSchedule("ags_rolled_back"))
              .pipe(
                Effect.andThen(Effect.fail("cancel concurrent transaction")),
              ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(Exit.isFailure(result[1])).toBe(true);
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_committed", revision: 1 },
  ]);
  await expectEmptyBuffer();
});

test("interruption rolls back captured writes before the next transaction", async () => {
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* db
          .transaction((tx) =>
            tx
              .run(insertSchedule("ags_interrupted"))
              .pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
              ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* db.transaction((tx) => tx.run(insertSchedule("ags_after")));
      }),
    ),
  );
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_after", revision: 1 },
  ]);
  expect(
    await runtime.runPromise(db.all(sql`SELECT id FROM agent_schedule`)),
  ).toEqual([{ id: "ags_after" }]);
  await expectEmptyBuffer();
});

test("rejects untracked autocommit writes and emits nothing for reads or no matching rows", async () => {
  const rejected = await runtime.runPromise(
    Effect.exit(db.run(insertSchedule("ags_outside"))),
  );
  expect(Exit.isFailure(rejected)).toBe(true);
  await runtime.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        expect(yield* tx.all(sql`SELECT * FROM agent_schedule`)).toEqual([]);
        yield* tx.run(sql`UPDATE agent_schedule SET revision = 2`);
        yield* tx.run(sql`DELETE FROM agent_schedule`);
      }),
    ),
  );
  expect(changes()).toEqual([]);
  await expectEmptyBuffer();
});

test("commit failure publishes nothing and does not poison the next transaction", async () => {
  const failed = await runtime.runPromise(
    Effect.exit(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.run(sql`PRAGMA defer_foreign_keys = ON`);
          yield* tx.run(insertSchedule("ags_uncommitted"));
          yield* tx.run(sql`
            INSERT INTO agent_schedule_occurrence (id, schedule_id, fire_at)
            VALUES ('aso_bad', 'ags_missing', 1)
          `);
        }),
      ),
    ),
  );
  expect(Exit.isFailure(failed)).toBe(true);
  expect(changes()).toEqual([]);
  await runtime.runPromise(
    db.transaction((tx) => tx.run(insertSchedule("ags_after_failure"))),
  );
  expect(changes()).toEqual([
    { table: "agent_schedule", id: "ags_after_failure", revision: 1 },
  ]);
  expect(
    await runtime.runPromise(db.all(sql`SELECT id FROM agent_schedule`)),
  ).toEqual([{ id: "ags_after_failure" }]);
  await expectEmptyBuffer();
});

test("recreates detectors on reopen without persisting buffers, triggers, or replaying rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resource-detector-"));
  const filename = join(directory, "application.sqlite3");
  try {
    for (const pass of [1, 2]) {
      const spy = vi.fn<Database.OnCommitted>(() => Effect.void);
      const reopened = makeRuntime(spy, filename);
      try {
        const connection = (await reopened.runPromise(Database.Service)).db;
        expect(spy).not.toHaveBeenCalled();
        const rows = await reopened.runPromise(
          connection.all(sql`SELECT id FROM agent_schedule ORDER BY id`),
        );
        expect(rows).toHaveLength(pass - 1);
        await reopened.runPromise(
          connection.transaction((tx) => tx.run(insertSchedule(`ags_${pass}`))),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]?.[0]).toEqual({
          table: "agent_schedule",
          id: `ags_${pass}`,
          revision: 1,
        });
      } finally {
        await reopened.dispose();
      }
    }
    const stored = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(
        stored
          .prepare(
            `
        SELECT name FROM sqlite_schema WHERE name LIKE 'resource_event_%'
      `,
          )
          .all(),
      ).toEqual([]);
    } finally {
      stored.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
