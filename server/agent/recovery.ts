// Purpose: Repairs abandoned Agent execution and wakes durable queues at startup.

import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Session } from "@openchart/server/agent/session";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { Effect } from "effect";

/**
 * Closes abandoned transcripts, fails running Runs, then wakes Sessions with
 * queued work. Returns after wake registration without waiting for queued Runs
 * to finish. The previous runtime must have stopped; this runtime exclusively
 * owns execution for the database.
 *
 * Startup awaits this once before scheduler dispatch or HTTP traffic. No queue
 * wakes before all repairs and Run publication finish. Repairs commit separately;
 * failure aborts startup and a later retry preserves already repaired state.
 * @example
 * yield* interruptAndRecover();
 */
export const interruptAndRecover = Effect.fn("Agent.interruptAndRecover")(
  function* () {
    const execution = yield* SessionExecution.Service;
    const session = yield* Session.Service;
    yield* session.interruptUnfinished();
    const queued = yield* AgentRunStore.recoverQueue();
    for (const sessionID of queued) yield* execution.wake(sessionID);
  },
);
