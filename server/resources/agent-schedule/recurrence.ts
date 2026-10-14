// Purpose: Calculates the Schedule cursor without starting a scheduler or executing a target.

import { ResourceStateInvalid } from "@openchart/server/lib/resource/errors";
import { Cron } from "croner";
import { Clock, Effect } from "effect";

import type { AgentScheduleRecurrence } from "./schema";

/**
 * Finds the first fire strictly after now for an already-validated recurrence.
 * A recurrence with no remaining fire fails before any Schedule write commits.
 *
 * @example
 * ```ts
 * const nextFireAt = yield* nextScheduleFire(recurrence);
 * ```
 */
export function nextScheduleFire(recurrence: AgentScheduleRecurrence) {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const next =
      recurrence.kind === "once"
        ? new Date(recurrence.fireAt).getTime()
        : new Cron(recurrence.expression, {
            mode: "5-part",
            paused: true,
            timezone: recurrence.timeZone,
          })
            .nextRun(new Date(now))
            ?.getTime();
    if (next === undefined || next <= now) {
      return yield* Effect.fail(
        new ResourceStateInvalid({
          resource: "agent_schedule",
          reason: "Schedule recurrence has no future fire",
          issues: [
            {
              code: "schedule.no_future_fire",
              path: "/recurrence",
              message: "Schedule recurrence must have a future fire",
            },
          ],
        }),
      );
    }
    return next;
  });
}
