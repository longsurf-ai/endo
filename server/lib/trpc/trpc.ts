// Purpose: Shared tRPC context and router builder for every V2 server module.

import type { Context } from "@openchart/server/context";
import { initTRPC, TRPCError } from "@trpc/server";

import { boundaryError, formatError } from "./errors";

const builder = initTRPC.context<Context>().create({
  errorFormatter: formatError,
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 30_000 },
  },
});

/**
 * Builds compatible routers and procedures for the V2 server.
 * Every feature router uses this instance so the server composition root can
 * nest them under one {@link @openchart/server!AppRouter}. Every procedure
 * inherits the shared error boundary, including its input parser.
 */
export const trpc = {
  ...builder,
  procedure: builder.procedure.use(async ({ next, signal }) => {
    const result = await next();
    if (!result.ok && signal?.aborted) {
      throw new TRPCError({ code: "CLIENT_CLOSED_REQUEST" });
    }
    if (!result.ok) throw boundaryError(result.error);
    return result;
  }),
};
