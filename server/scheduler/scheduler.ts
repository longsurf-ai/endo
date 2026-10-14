// Purpose: Dispatches due schedules through shared Agent admission with best-effort idempotent bookkeeping.

/**
 * Scheduled dispatch; the background Layer owns one application-lifetime loop.
 * @packageDocumentation
 */
export * as Scheduler from "./scheduler";

import { SessionId } from "@openchart/server/agent/contracts/session";
import { admitPromptTarget } from "@openchart/server/agent/session/admit-prompt-target";
import { Transactor, Transition } from "@openchart/server/lib/resource";
import {
  advanceSchedule,
  agentScheduleResource,
  type AgentSchedule,
  type AgentScheduleId,
} from "@openchart/server/resources/agent-schedule";
import { agentScheduleOccurrenceResource } from "@openchart/server/resources/agent-schedule-occurrence";
import { Clock, Context, Effect, Layer } from "effect";

/** Application-wide scheduled dispatch through target-owned admission APIs. */
export interface Interface {
  /**
   * Scans immediately, then waits thirty seconds after each completed scan.
   * Application composition owns one invocation and interrupts it on shutdown.
   * Scans and admissions are sequential; accepted Runs execute independently.
   * Expected failures are logged and retried by later scans. Defects and
   * interruption propagate. This method never forks or wraps admissions in a transaction.
   * @example
   * const scheduler = yield* Scheduler.Service;
   * yield* scheduler.runLoop();
   */
  readonly runLoop: typeof runLoop;
  /**
   * Admits one fire at the current server time, including for disabled schedules.
   * Returns its occurrence without waiting for execution. Keeps the definition,
   * enabled state and recurring cursor unchanged; admission/bookkeeping errors propagate.
   * @example yield* scheduler.runNow(schedule.id);
   */
  readonly runNow: typeof runNow;
}

/**
 * Scheduler capability supplied by application composition. Providing the
 * service starts no work; its background Layer forks runLoop.
 * @example
 * const scheduler = yield* Scheduler.Service;
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Scheduler",
) {}

const record = (
  schedule: AgentSchedule,
  fireAt: number,
  run?: { readonly id: string; readonly sessionID: string },
) =>
  Transactor.run(
    agentScheduleOccurrenceResource.transitions.ensureOccurrence({
      scheduleId: schedule.id,
      fireAt,
      agentRunId: run?.id ?? null,
      sessionId: run ? SessionId.make(run.sessionID) : null,
    }),
  );

const dispatch = Effect.fn("Scheduler.dispatch")(function* (
  schedule: AgentSchedule,
  fireAt: number,
) {
  const intent = `schedule:${schedule.id}:${fireAt}`;
  const target = schedule.target;
  switch (target.kind) {
    case "agent_prompt":
      return yield* record(
        schedule,
        fireAt,
        yield* admitPromptTarget({
          intent,
          title: schedule.name,
          binding: target.binding,
          input: target.prompt,
        }),
      );
    default:
      // A new target kind fails to compile here instead of silently doing nothing.
      return target.kind satisfies never;
  }
});

const runNow = Effect.fn("Scheduler.runNow")(function* (id: AgentScheduleId) {
  const schedule = yield* Transactor.run(
    agentScheduleResource.transitions.get(id),
  );
  const fireAt = yield* Clock.currentTimeMillis;
  return yield* dispatch(schedule, fireAt);
});

const scan = Effect.fn("Scheduler.scan")(function* () {
  const now = yield* Clock.currentTimeMillis;
  const dueSchedules = yield* Transactor.run(
    Transition.from((tx) =>
      Effect.gen(function* () {
        const schedules = yield* agentScheduleResource.transitions
          .listAll()
          .apply(tx);
        const eligible = yield* Effect.filter(schedules, (schedule) =>
          Effect.gen(function* () {
            if (!schedule.enabled || schedule.nextFireAt > now) return false;
            if (schedule.recurrence.kind !== "once") return true;

            const occurrences =
              yield* agentScheduleOccurrenceResource.transitions
                .listAll({ filter: { scheduleId: schedule.id } })
                .apply(tx);
            return !occurrences.some(
              (occurrence) => occurrence.fireAt === schedule.nextFireAt,
            );
          }),
        );
        return eligible.sort(
          (a, b) =>
            a.nextFireAt - b.nextFireAt ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      }),
    ),
  );
  yield* Effect.forEach(
    dueSchedules,
    (schedule) =>
      dispatch(schedule, schedule.nextFireAt).pipe(
        // Only the timed loop advances the cursor after admission and history commit.
        Effect.andThen(
          Transactor.run(Transition.bindInput(advanceSchedule, schedule)),
        ),
        Effect.catch((error) =>
          Effect.logError("Scheduled dispatch failed; will retry", {
            scheduleId: schedule.id,
            fireAt: schedule.nextFireAt,
            error,
          }),
        ),
      ),
    { discard: true },
  );
});

const runLoop = Effect.fn("Scheduler.runLoop")(function* () {
  yield* scan().pipe(
    Effect.catch((error) =>
      Effect.logError("Schedule scan failed; will retry", error),
    ),
  );
  yield* Effect.sleep("30 seconds");
}, Effect.forever);

/**
 * Registers periodic dispatch without acquiring dependencies or starting work.
 * runLoop retains its inferred requirements; application composition supplies them
 * to the background Layer. Target writes keep their transaction boundaries.
 * @example
 * const services = Layer.merge(Scheduler.layer, applicationServices);
 */
export const layer = Layer.succeed(Service, { runLoop, runNow });
