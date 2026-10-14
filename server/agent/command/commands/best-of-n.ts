// Purpose: Compiles the researcher count and question into a WorkflowPart.
import { defineCommand } from "@openchart/server/agent/command/definition";
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { UnsupportedCommandPart } from "@openchart/server/agent/command/errors";
import { formatRestArgument } from "@openchart/server/agent/command/template";
import { Effect, Schema } from "effect";

const bestOfNArgs = Schema.Struct({
  n: Schema.Int.check(Schema.isGreaterThan(0)),
  question: Schema.String.check(Schema.isMinLength(1)),
});

/** $1 is the count; the highest placeholder $2 captures the complete question. */
export const bestOfNCommand = defineCommand({
  name: "best-of-n",
  type: "workflow",
  description:
    "Research with n independent agents, then synthesize their answers",
  argumentHint:
    "Usage: <count> <question>. Count must be a positive integer. Example: 3 Research Google.",
  template: "$1 $2",
  buildParts: ({ captures }) =>
    Schema.decodeUnknownEffect(bestOfNArgs)({
      n: Number(captures.$1),
      question: captures.$2,
    }).pipe(
      Effect.map((args) => [
        {
          type: "workflow",
          workflow: "default:workflows/best-of-n.workflow.ts",
          args,
        },
      ]),
    ),
  restoreArgumentsFromParts: Effect.fn("BestOfNCommand.restore")(function* (
    parts: readonly AgentPromptPartInput[],
  ) {
    const [part] = parts;
    if (
      parts.length !== 1 ||
      part?.type !== "workflow" ||
      part.workflow !== "default:workflows/best-of-n.workflow.ts"
    )
      return undefined;
    const args = yield* Schema.decodeUnknownEffect(bestOfNArgs)(part.args);
    const question = formatRestArgument(args.question);
    if (question === undefined) return yield* new UnsupportedCommandPart({});
    return `${args.n} ${question}`;
  }),
});
