// Purpose: Projects service-free JSON data schemas for native final-answer constraints.

import { InvalidOutputSchema } from "@openchart/server/agent/workflow/errors";
import { Effect, Schema } from "effect";

/**
 * Projects the encoded JSON shape, retaining definitions through Effect's adapter.
 * Projection failures are reported before child creation.
 * @example
 * const json = yield* outputSchema(Schema.Struct({passed: Schema.Boolean}));
 */
export const outputSchema = Effect.fnUntraced(function* (
  schema: Schema.Codec<Schema.Json, Schema.Json>,
) {
  return yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Schema.JsonObject)(
        Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({
          target: "draft-07",
        }),
      ),
    catch: (cause) =>
      new InvalidOutputSchema({
        message: String(cause),
        cause,
      }),
  });
});
