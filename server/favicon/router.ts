// Purpose: Expose optional, read-only website icons to the renderer.
import { Schema } from "effect";
import { trpc } from "@openchart/server/lib/trpc";
import { favicon } from "./favicon";

export const faviconRouter = trpc.router({
  get: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          hostname: Schema.String.check(
            Schema.isMaxLength(253),
            Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i),
          ),
        }),
        { parseOptions: { onExcessProperty: "error" } },
      ),
    )
    .query(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(favicon(input.hostname), { signal }),
    ),
});
