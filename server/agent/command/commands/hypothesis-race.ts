// Purpose: Compiles a free-form question into a structured competing-explanations workflow.
import { defineCommand } from "@openchart/server/agent/command/definition";
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Effect, Schema } from "effect";

const hypothesisRaceArgs = Schema.Struct({
  question: Schema.String.check(Schema.isPattern(/\S/)),
});

/** Preserves the raw question, including quotes and line breaks, when editing. */
export const hypothesisRaceCommand = defineCommand({
  name: "hypothesis-race",
  type: "workflow",
  description:
    "Compare up to five explanations and investigate the question that best distinguishes them",
  argumentHint:
    "Usage: <question>. Example: Why did signups drop after the redesign?",
  template: "$ARGUMENTS",
  buildParts: ({ captures }) =>
    Schema.decodeUnknownEffect(hypothesisRaceArgs)({
      question: captures.$ARGUMENTS,
    }).pipe(
      Effect.map((args) => [
        {
          type: "workflow",
          workflow: "default:workflows/hypothesis-race.workflow.ts",
          args,
        },
      ]),
    ),
  restoreArgumentsFromParts: Effect.fn("HypothesisRaceCommand.restore")(
    function* (parts: readonly AgentPromptPartInput[]) {
      const [part] = parts;
      if (
        parts.length !== 1 ||
        part?.type !== "workflow" ||
        part.workflow !== "default:workflows/hypothesis-race.workflow.ts"
      )
        return undefined;
      const args = yield* Schema.decodeUnknownEffect(hypothesisRaceArgs)(
        part.args,
      );
      return args.question;
    },
  ),
});
