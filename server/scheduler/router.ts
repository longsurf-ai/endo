// Purpose: Expose explicit schedule admission without changing Resource definitions.
import { trpc } from "@openchart/server/lib/trpc";
import { AgentScheduleId } from "@openchart/server/resources/agent-schedule";
import { Schema } from "effect";

import { Scheduler } from "./scheduler";

/** Manual schedule actions; accepted Runs execute independently of the request. */
export const schedulerRouter = trpc.router({
  runNow: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(Schema.Struct({ id: AgentScheduleId }), {
        parseOptions: { onExcessProperty: "error" },
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Scheduler.Service.use((scheduler) => scheduler.runNow(input.id)),
      ),
    ),
});
