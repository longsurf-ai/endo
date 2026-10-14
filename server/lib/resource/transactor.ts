// Purpose: Resolves an operation before executing its apply phase in one database transaction.

import { Database } from "@openchart/server/db";
import { Effect } from "effect";

import type { Transition } from "./transition";

/**
 * Resolves external facts, then runs apply in one Database transaction.
 *
 * Resolve failure opens no transaction. Apply failure or a defect rolls back
 * its database writes; Database owns commit and subsequent change delivery.
 * Resource semantics and composition belong to the supplied transition.
 * Call this once at the execution boundary, never from another apply phase.
 *
 * @param transition - Input-bound resolve and apply phases to execute.
 * @returns The apply result, preserving resolver, apply, and database failures.
 *
 * @example
 * ```ts
 * const created = yield* Transactor.run(
 *   agentScheduleResource.transitions.create(body),
 * );
 * ```
 */
export function run<Resolved, A, EResolve, EApply, RResolve>(
  transition: Transition<Resolved, A, EResolve, EApply, RResolve>,
) {
  return Effect.gen(function* () {
    const resolved = yield* transition.resolve;
    const { db } = yield* Database.Service;
    return yield* db.transaction((tx) => transition.apply(tx, resolved));
  });
}
