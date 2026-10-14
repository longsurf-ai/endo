// Purpose: Compiles the round count and topic into a multi-turn debate WorkflowPart.
import { defineCommand } from "@openchart/server/agent/command/definition";
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { UnsupportedCommandPart } from "@openchart/server/agent/command/errors";
import { formatRestArgument } from "@openchart/server/agent/command/template";
import { Effect, Schema } from "effect";

const multiTurnDebateArgs = Schema.Struct({
  round: Schema.Int.check(Schema.isGreaterThan(0)),
  topic: Schema.String.check(Schema.isMinLength(1)),
});

/** $1 is the round count; the highest placeholder $2 captures the complete topic. */
export const multiTurnDebateCommand = defineCommand({
  name: "multi-turn-debate",
  type: "workflow",
  description:
    "Debate any topic from affirmative and negative perspectives using your selected model, then summarize every round",
  argumentHint:
    "Usage: <round> <topic>. Round count must be a positive integer. Example: 3 Should public transit be free?",
  template: "$1 $2",
  buildParts: ({ captures }) =>
    Schema.decodeUnknownEffect(multiTurnDebateArgs)({
      round: Number(captures.$1),
      topic: captures.$2,
    }).pipe(
      Effect.map((args) => [
        {
          type: "workflow",
          workflow: "default:workflows/multi-turn-debate.workflow.ts",
          args,
        },
      ]),
    ),
  restoreArgumentsFromParts: Effect.fn("MultiTurnDebateCommand.restore")(
    function* (parts: readonly AgentPromptPartInput[]) {
      const [part] = parts;
      if (
        parts.length !== 1 ||
        part?.type !== "workflow" ||
        part.workflow !== "default:workflows/multi-turn-debate.workflow.ts"
      )
        return undefined;
      const args = yield* Schema.decodeUnknownEffect(multiTurnDebateArgs)(
        part.args,
      );
      const topic = formatRestArgument(args.topic);
      if (topic === undefined) return yield* new UnsupportedCommandPart({});
      return `${args.round} ${topic}`;
    },
  ),
});
