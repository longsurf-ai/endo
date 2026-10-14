// Purpose: Expose cross-Resource operations under resources.macro.

import { trpc } from "@openchart/server/lib/trpc";

/**
 * Cross-Resource queries and mutations. Each procedure runs one composed
 * transition from `resources/macros/` through `Transactor.run`, keeping the
 * owning operation's execution contract. Empty until an application needs one.
 * @example
 * // createProjectWithSchedule: trpc.procedure.mutation(({ ctx }) =>
 * //   ctx.runtime.runPromise(Transactor.run(createProjectWithSchedule())))
 */
export const macroRouter = trpc.router({});
