// Purpose: Expose optional web page metadata for hovered links.
import { Schema } from "effect";
import { trpc } from "@openchart/server/lib/trpc";
import { linkPreview } from "./link-preview";

export const linkPreviewRouter = trpc.router({
  get: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(4096)) }),
        { parseOptions: { onExcessProperty: "error" } },
      ),
    )
    .query(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(linkPreview(input.url), { signal }),
    ),
});
