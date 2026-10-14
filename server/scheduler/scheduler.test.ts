// Purpose: Verifies scheduled admission, independent commits, retries, timing, and interruption through Scheduler.Service.

import { SessionId } from "@openchart/server/agent/contracts/session";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { agentRun, agentSessions } from "@openchart/server/agent/schema";
import { Session } from "@openchart/server/agent/session";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Transactor } from "@openchart/server/lib/resource";
import * as ResourceEvents from "@openchart/server/lib/resource/events";
import {
  agentScheduleResource,
  type AgentSchedule,
} from "@openchart/server/resources/agent-schedule";
import { agentScheduleOccurrenceResource } from "@openchart/server/resources/agent-schedule-occurrence";
import { sql } from "drizzle-orm";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test, vi } from "vitest";

import { Scheduler } from "./scheduler";

const prompt = {
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text" as const, text: "Research." }],
};
const once = { kind: "once" as const, fireAt: "1970-01-01T00:00:00.000Z" };
const cron = {
  kind: "cron" as const,
  expression: "* * * * *",
  timeZone: "UTC",
};
type Services =
  | Scheduler.Service
  | Database.Service
  | AgentRunStore.Service
  | Session.Service
  | SessionExecution.Service
  | Events.Service
  | Publisher.Service
  | Scope.Scope;

function run<A, E>(program: Effect.Effect<A, E, Services>) {
  const database = Layer.unwrap(
    Effect.map(Events.Service, (events) =>
      Database.layer(":memory:", ResourceEvents.makeOnCommitted(events)),
    ),
  ).pipe(Layer.provideMerge(Events.layer));
  const dependencies = Layer.mergeAll(
    database,
    Session.layer,
    Layer.sync(Publisher.Service, () => ({
      publish: vi.fn(() => Effect.void),
    })),
    Layer.sync(SessionExecution.Service, () => ({
      active: Effect.succeed(new Set<string>()),
      wake: vi.fn<SessionExecution.Interface["wake"]>(() => Effect.void),
      interrupt: () => Effect.void,
    })),
  );
  const layer = Scheduler.layer.pipe(
    Layer.provideMerge(
      AgentRunStore.layer.pipe(Layer.provideMerge(dependencies)),
    ),
  );
  return Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );
}

const create = (
  options: Partial<typeof agentScheduleResource.body.Type> = {},
) =>
  Transactor.run(
    agentScheduleResource.transitions.create({
      name: "Research",
      enabled: true,
      target: { kind: "agent_prompt", prompt },
      recurrence: once,
      nextFireAt: 0,
      ...options,
    }),
  );
const read = (schedule: AgentSchedule) =>
  Transactor.run(agentScheduleResource.transitions.get(schedule.id));
const occurrences = (schedule: AgentSchedule) =>
  Transactor.run(
    agentScheduleOccurrenceResource.transitions.list({
      filter: { scheduleId: schedule.id },
    }),
  );
const start = Effect.fn("test.startScheduler")(function* () {
  const scheduler = yield* Scheduler.Service;
  const scanned = yield* Deferred.make<void>();
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        if (options.name === "Scheduler.scan")
          Deferred.doneUnsafe(scanned, Effect.void);
      };
      return span;
    },
  });
  const fiber = yield* scheduler
    .runLoop()
    .pipe(Effect.withTracer(tracer), Effect.forkScoped);
  yield* Effect.raceFirst(Deferred.await(scanned), Fiber.join(fiber));
  yield* TestClock.adjust(0);
  return fiber;
});

afterEach(() => vi.restoreAllMocks());

test.each([true, false])(
  "manually runs a schedule with enabled=%s, records history, and preserves its definition",
  (enabled) =>
    run(
      Effect.gen(function* () {
        const schedule = yield* create({
          enabled,
          recurrence: cron,
          nextFireAt: 60_000,
          target: {
            kind: "agent_prompt",
            prompt,
            binding: { key: "manual-review" },
          },
        });
        const scheduler = yield* Scheduler.Service;
        const store = yield* AgentRunStore.Service;
        const execution = yield* SessionExecution.Service;
        yield* TestClock.adjust(1_000);
        const first = yield* scheduler.runNow(schedule.id);
        expect(first).toMatchObject({ scheduleId: schedule.id, fireAt: 1_000 });
        const accepted = yield* store.getByIntent(
          `schedule:${schedule.id}:1000`,
        );
        expect(accepted).toMatchObject({
          id: first.agentRunId,
          sessionID: first.sessionId,
          input: prompt,
          status: "queued",
        });
        yield* TestClock.adjust(1);
        const second = yield* scheduler.runNow(schedule.id);
        expect(second.agentRunId).not.toBe(first.agentRunId);
        expect(second.sessionId).toBe(first.sessionId);
        expect((yield* occurrences(schedule)).items).toEqual([first, second]);
        expect(yield* read(schedule)).toEqual(schedule);
        expect(execution.wake).toHaveBeenCalledTimes(2);
      }),
    ),
);

test("a manual fire does not exhaust a future one-time fire", () =>
  run(
    Effect.gen(function* () {
      const schedule = yield* create({
        nextFireAt: 30_000,
        recurrence: { kind: "once", fireAt: "1970-01-01T00:00:30.000Z" },
      });
      const scheduler = yield* Scheduler.Service;
      yield* TestClock.adjust(1_000);
      yield* scheduler.runNow(schedule.id);
      yield* start();
      yield* TestClock.adjust("30 seconds");
      expect(
        (yield* occurrences(schedule)).items.map((item) => item.fireAt),
      ).toEqual([1_000, 30_000]);
      expect(yield* read(schedule)).toEqual(schedule);
    }),
  ));

test("scans immediately and every thirty seconds; skips disabled, future, and accepted one-time fires", () =>
  run(
    Effect.gen(function* () {
      const due = yield* create();
      const future = yield* create({
        nextFireAt: 30_000,
        recurrence: { ...once, fireAt: "1970-01-01T00:00:30.000Z" },
      });
      const paused = yield* create({ enabled: false });
      const { db } = yield* Database.Service;
      const execution = yield* SessionExecution.Service;
      const scheduler = yield* Scheduler.Service;
      const scans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          if (options.name === "Scheduler.scan") scans.push(span);
          return span;
        },
      });
      expect(yield* db.select().from(agentRun)).toEqual([]);
      const fiber = yield* scheduler
        .runLoop()
        .pipe(Effect.withTracer(tracer), Effect.forkScoped);
      yield* TestClock.adjust(0);
      expect(scans).toHaveLength(1);
      expect((yield* occurrences(due)).items).toHaveLength(1);
      expect(yield* read(due)).toEqual(due);
      expect((yield* occurrences(future)).items).toHaveLength(0);
      expect((yield* occurrences(paused)).items).toHaveLength(0);
      yield* TestClock.adjust(29_999);
      expect(scans).toHaveLength(1);
      yield* TestClock.adjust(1);
      expect(scans).toHaveLength(2);
      expect((yield* occurrences(future)).items).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(scans).toHaveLength(4);
      expect(execution.wake).toHaveBeenCalledTimes(2);
      expect(yield* db.select().from(agentRun)).toHaveLength(2);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
        true,
      );
      yield* TestClock.adjust("1 minute");
      expect(scans).toHaveLength(4);
    }),
  ));

test("reads past filtered Schedule pages and admits in fire-time then id order", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.adjust(30);
      const later = yield* create({ nextFireAt: 30 });
      yield* Effect.forEach(Array.from({ length: 120 }), (_, index) =>
        create(index % 2 === 0 ? { enabled: false } : { nextFireAt: 31 }),
      );
      const earlier = yield* create({ nextFireAt: 10 });
      const tied = yield* create({ nextFireAt: 10 });
      const firstPage = yield* Transactor.run(
        agentScheduleResource.transitions.list({ limit: 100 }),
      );
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.items.some((item) => item.id === earlier.id)).toBe(
        false,
      );
      const store = yield* AgentRunStore.Service;
      const enqueue = vi.spyOn(store, "enqueue");
      yield* start();
      const ordered = [earlier, tied].sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(
        enqueue.mock.calls.map(([input]) => input.sessionIntentID),
      ).toEqual(
        [...ordered, later].map(
          (schedule) => `schedule:${schedule.id}:${schedule.nextFireAt}`,
        ),
      );
    }),
  ));

test("reads every Occurrence page and excludes only the exact accepted one-time fire", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.adjust(200);
      const exhausted = yield* create({ nextFireAt: 200 });
      const differentFire = yield* create({ nextFireAt: 199 });
      const sameFire = yield* create({ nextFireAt: 200 });
      const store = yield* AgentRunStore.Service;
      const sessions = yield* Session.Service;
      const session = yield* sessions.create({ title: "Existing fires" });
      const accept = (schedule: AgentSchedule, fireAt: number) =>
        Effect.gen(function* () {
          const accepted = yield* store.enqueue({
            sessionID: session.id,
            sessionIntentID: `schedule:${schedule.id}:${fireAt}`,
            input: prompt,
          });
          yield* Transactor.run(
            agentScheduleOccurrenceResource.transitions.create({
              scheduleId: schedule.id,
              fireAt,
              agentRunId: accepted.id,
              sessionId: SessionId.make(session.id),
            }),
          );
        });
      for (let fireAt = 0; fireAt < 120; fireAt++)
        yield* accept(exhausted, fireAt);
      yield* accept(exhausted, 200);
      yield* accept(differentFire, 200);
      const firstPage = yield* Transactor.run(
        agentScheduleOccurrenceResource.transitions.list({
          filter: { scheduleId: exhausted.id },
          limit: 100,
        }),
      );
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.items.some((item) => item.fireAt === 200)).toBe(false);
      const enqueue = vi.spyOn(store, "enqueue");
      yield* start();
      expect(
        enqueue.mock.calls.map(([input]) => input.sessionIntentID),
      ).toEqual([
        `schedule:${differentFire.id}:199`,
        `schedule:${sameFire.id}:200`,
      ]);
      expect(yield* read(exhausted)).toEqual(exhausted);
    }),
  ));

test("skips missed cron intervals, reuses bindings, and leaves run execution independent", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.adjust(125_000);
      const schedule = yield* create({
        recurrence: cron,
        target: {
          kind: "agent_prompt",
          prompt,
          binding: { key: "research:watchlist" },
        },
      });
      const other = yield* create({
        target: {
          kind: "agent_prompt",
          prompt,
          binding: { key: "research:watchlist" },
        },
      });
      const { db } = yield* Database.Service;
      yield* start();
      expect(yield* read(schedule)).toMatchObject({
        nextFireAt: 180_000,
        revision: 2,
        enabled: true,
      });
      const first = (yield* occurrences(schedule)).items[0]!;
      expect((yield* occurrences(other)).items[0]?.sessionId).toBe(
        first.sessionId,
      );
      expect(yield* db.select().from(agentSessions)).toHaveLength(1);
      yield* TestClock.adjust(60_000);
      const fires = (yield* occurrences(schedule)).items;
      expect(fires.map((fire) => fire.fireAt)).toEqual([0, 180_000]);
      expect(fires.every((fire) => fire.sessionId === first.sessionId)).toBe(
        true,
      );
      expect(
        (yield* db.select().from(agentRun)).map((run) => run.status),
      ).toEqual(["queued", "queued", "queued"]);
      expect(yield* read(schedule)).toMatchObject({
        nextFireAt: 240_000,
        revision: 3,
      });
    }),
  ));

test("advances cron in its authored time zone", () =>
  run(
    Effect.gen(function* () {
      const now = Date.parse("2026-03-08T13:01:00.000Z");
      yield* TestClock.adjust(now);
      const schedule = yield* create({
        nextFireAt: now - 60_000,
        recurrence: {
          kind: "cron",
          expression: "0 9 * * *",
          timeZone: "America/New_York",
        },
      });
      yield* start();
      expect((yield* read(schedule)).nextFireAt).toBe(
        Date.parse("2026-03-09T13:00:00.000Z"),
      );
    }),
  ));

test("an admission failure leaves the cursor and occurrence untouched while later pages still run", () =>
  run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      const failed = yield* create();
      yield* db.run(
        sql.raw(`CREATE TRIGGER reject_run BEFORE INSERT ON agent_run
    WHEN NEW.session_intent_id = 'schedule:${failed.id}:0'
    BEGIN SELECT RAISE(FAIL, 'injected admission failure'); END`),
      );
      const rest = yield* Effect.forEach(Array.from({ length: 101 }), () =>
        create(),
      );
      yield* start();
      expect((yield* occurrences(failed)).items).toHaveLength(0);
      expect(yield* read(failed)).toEqual(failed);
      expect(yield* db.select().from(agentRun)).toHaveLength(101);
      expect((yield* occurrences(rest.at(-1)!)).items).toHaveLength(1);
      yield* db.run(sql`DROP TRIGGER reject_run`);
      yield* TestClock.adjust("30 seconds");
      expect(yield* db.select().from(agentRun)).toHaveLength(102);
      expect((yield* occurrences(failed)).items).toHaveLength(1);
      // An empty Session after failed admission is allowed by the best-effort contract.
      expect(yield* db.select().from(agentSessions)).toHaveLength(103);
    }),
  ));

test("retry after occurrence failure reuses the accepted Run, Session, and input despite target edits", () =>
  run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      const store = yield* AgentRunStore.Service;
      const sessions = yield* Session.Service;
      const execution = yield* SessionExecution.Service;
      const schedule = yield* create({ recurrence: cron });
      yield* db.run(sql`CREATE TRIGGER reject_occurrence BEFORE INSERT ON agent_schedule_occurrence
    BEGIN SELECT RAISE(FAIL, 'injected occurrence failure'); END`);
      const fiber = yield* start();
      const accepted = (yield* store.getByIntent(`schedule:${schedule.id}:0`))!;
      expect(accepted.input).toEqual(prompt);
      expect((yield* occurrences(schedule)).items).toHaveLength(0);
      expect(yield* read(schedule)).toEqual(schedule);
      yield* Fiber.interrupt(fiber);
      yield* store.claim(accepted.sessionID);
      yield* store.complete(accepted.id);
      const replacement = yield* sessions.getOrCreateBound({
        key: "replacement",
        kind: "chat",
      });
      yield* Transactor.run(
        agentScheduleResource.transitions.patch({
          id: schedule.id,
          expectedRevision: 1,
          operations: [
            {
              op: "replace",
              path: "/target",
              value: {
                kind: "agent_prompt",
                prompt: {
                  ...prompt,
                  parts: [{ type: "text", text: "Edited prompt" }],
                },
                binding: { key: "replacement" },
              },
            },
          ],
        }),
      );
      yield* db.run(sql`DROP TRIGGER reject_occurrence`);
      yield* start();
      const occurrence = (yield* occurrences(schedule)).items[0]!;
      expect(occurrence).toMatchObject({
        agentRunId: accepted.id,
        sessionId: accepted.sessionID,
        fireAt: 0,
      });
      expect(occurrence.sessionId).not.toBe(replacement.id);
      expect(yield* store.get(accepted.id)).toMatchObject({
        status: "completed",
        input: prompt,
      });
      expect(yield* db.select().from(agentRun)).toHaveLength(1);
      expect(execution.wake).toHaveBeenNthCalledWith(2, accepted.sessionID);
      expect(yield* read(schedule)).toMatchObject({
        revision: 3,
        nextFireAt: 60_000,
      });
    }),
  ));

test("cursor failure preserves the committed occurrence and retry publishes no duplicate occurrence", () =>
  run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      const events = yield* Events.Service;
      const publish = vi.spyOn(events, "publish");
      const schedule = yield* create({ recurrence: cron });
      yield* db.run(sql`CREATE TRIGGER reject_cursor BEFORE UPDATE OF next_fire_at ON agent_schedule
    BEGIN SELECT RAISE(FAIL, 'injected cursor failure'); END`);
      const fiber = yield* start();
      const first = (yield* occurrences(schedule)).items[0]!;
      expect(first).toBeDefined();
      expect(yield* read(schedule)).toEqual(schedule);
      expect(yield* db.select().from(agentRun)).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
      yield* db.run(sql`DROP TRIGGER reject_cursor`);
      yield* start();
      expect((yield* occurrences(schedule)).items).toEqual([first]);
      expect(yield* db.select().from(agentRun)).toHaveLength(1);
      expect(yield* read(schedule)).toMatchObject({
        revision: 2,
        nextFireAt: 60_000,
      });
      const changes = publish.mock.calls
        .filter(([definition]) => definition === ResourceEvents.ResourceChanged)
        .map(([, payload]) => payload);
      expect(changes).toEqual([
        { resource: "agent_schedule", id: schedule.id, revision: 1 },
        { resource: "agent_schedule_occurrence", id: first.id, revision: 1 },
        { resource: "agent_schedule", id: schedule.id, revision: 2 },
      ]);
    }),
  ));

test.each(["rename", "pause", "recurrence", "delete"] as const)(
  "a %s during admission cannot be overwritten by cursor advancement",
  (action) =>
    run(
      Effect.gen(function* () {
        const schedule = yield* create({ recurrence: cron });
        const execution = yield* SessionExecution.Service;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        vi.spyOn(execution, "wake").mockImplementationOnce(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        );
        const scheduler = yield* Scheduler.Service;
        yield* scheduler.runLoop().pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        let edited: AgentSchedule | undefined;
        if (action === "delete")
          yield* Transactor.run(
            agentScheduleResource.transitions.remove(schedule.id),
          );
        else
          edited = yield* Transactor.run(
            agentScheduleResource.transitions.patch({
              id: schedule.id,
              expectedRevision: 1,
              operations: [
                action === "rename"
                  ? { op: "replace", path: "/name", value: "Edited" }
                  : action === "pause"
                    ? { op: "replace", path: "/enabled", value: false }
                    : {
                        op: "replace",
                        path: "/recurrence",
                        value: {
                          kind: "cron",
                          expression: "0 * * * *",
                          timeZone: "UTC",
                        },
                      },
              ],
            }),
          );
        yield* Deferred.succeed(release, undefined);
        yield* TestClock.adjust(0);
        const { db } = yield* Database.Service;
        expect(yield* db.select().from(agentRun)).toHaveLength(1);
        if (edited) {
          expect(yield* read(schedule)).toEqual(edited);
          expect((yield* occurrences(schedule)).items).toHaveLength(1);
        } else {
          expect((yield* occurrences(schedule)).items).toHaveLength(0);
          expect(
            (yield* Transactor.run(agentScheduleResource.transitions.list()))
              .items,
          ).toHaveLength(0);
        }
      }),
    ),
);

test("slow admission never overlaps a scan and interruption stops the wait", () =>
  run(
    Effect.gen(function* () {
      const schedule = yield* create({ recurrence: cron });
      const entered = yield* Deferred.make<void>();
      const execution = yield* SessionExecution.Service;
      vi.spyOn(execution, "wake").mockImplementation(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const scheduler = yield* Scheduler.Service;
      const fiber = yield* scheduler.runLoop().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("2 minutes");
      expect(execution.wake).toHaveBeenCalledTimes(1);
      expect((yield* occurrences(schedule)).items).toHaveLength(0);
      yield* Fiber.interrupt(fiber);
      expect(yield* read(schedule)).toEqual(schedule);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
        true,
      );
      vi.mocked(execution.wake).mockImplementation(() => Effect.void);
      yield* start();
      expect((yield* occurrences(schedule)).items).toHaveLength(1);
      const { db } = yield* Database.Service;
      expect(yield* db.select().from(agentRun)).toHaveLength(1);
    }),
  ));

test("defects stop the loop instead of being treated as retryable failures", () =>
  run(
    Effect.gen(function* () {
      yield* create();
      const sessions = yield* Session.Service;
      vi.spyOn(sessions, "create").mockImplementationOnce(() =>
        Effect.die(new Error("injected defect")),
      );
      const scheduler = yield* Scheduler.Service;
      const exit = yield* scheduler.runLoop().pipe(Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  ));
