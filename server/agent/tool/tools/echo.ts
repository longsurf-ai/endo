// Purpose: Defines the Echo tool that prefixes an unchanged string with "echo ".

import * as Tool from "@openchart/server/agent/tool/tool";
import { Effect, Schema } from "effect";

/** Echo requires an object whose text field preserves empty strings and whitespace. */
export const Parameters = Schema.Struct({ text: Schema.String });

/**
 * Constructs Echo without executing it. The Tool wrapper owns decoding; the
 * invocation's permission callback authorizes the exact text before output.
 * @example
 * const echo = yield* Tool.init(yield* EchoTool);
 * const result = yield* echo.execute({text: 'hello'}, context);
 * // result.output is {type: 'text', value: 'echo hello'}.
 */
export const EchoTool = Tool.define(
  "echo",
  Effect.succeed({
    description: 'Echo the text field with the prefix "echo ".',
    parameters: Parameters,
    execute: Effect.fn("Echo.execute")(function* (
      input: typeof Parameters.Type,
      context: Tool.Context,
    ) {
      yield* context.ask({
        permission: "echo",
        patterns: [input.text],
        always: [input.text],
        metadata: { text: input.text },
      });
      return {
        title: "Echo",
        metadata: {},
        output: { type: "text" as const, value: `echo ${input.text}` },
      };
    }),
  }),
);
