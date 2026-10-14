// Purpose: Defines trusted workflows with immutable decoded arguments.

import type { Workflow } from "@openchart/server/agent/workflow";
import type {
  Definition,
  InvocationContext,
} from "@openchart/server/agent/workflow/runtime";
import { Effect, Schema } from "effect";
import { immutable } from "./shared/immutable";

/**
 * Defines one trusted workflow. Its workspace file owns identity.
 * The program may import only the authoring index; application effects enter through agent().
 * @example
 * const workflow = defineWorkflow({
 *   description: 'Research a question',
 *   args: Schema.Struct({question: Schema.String}),
 *   run: ({question}, {parentPrompt}) => agent({
 *     ...parentPrompt, parts: [{type: 'text', text: question}],
 *   }),
 * });
 */
export function defineWorkflow<
  S extends Schema.Decoder<Schema.JsonObject>,
>(input: {
  readonly description: string;
  readonly args: S;
  readonly run: (
    args: S["Type"],
    context: InvocationContext,
  ) => Effect.Effect<Schema.Json, unknown, Workflow.Service>;
}): Definition {
  return Object.freeze({
    kind: "workflow" as const,
    description: input.description,
    execute: (
      args: Schema.JsonObject,
      context: InvocationContext,
      onPrepared: (args: Schema.JsonObject) => Effect.Effect<void, unknown>,
    ) =>
      Schema.decodeUnknownEffect(input.args)(args).pipe(
        Effect.flatMap((parsed) => {
          const prepared = immutable(parsed);
          return onPrepared(prepared).pipe(
            Effect.andThen(Effect.suspend(() => input.run(prepared, context))),
          );
        }),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      ),
  });
}
