// Purpose: Compiles a free-form thesis into a structured assumption-challenge workflow.
import { defineCommand } from "@openchart/server/agent/command/definition";
import type { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Effect, Schema } from "effect";

const thesisKillerArgs = Schema.Struct({
  thesis: Schema.String.check(Schema.isPattern(/\S/)),
});

/** Preserves the raw thesis, including quotes and line breaks, when editing. */
export const thesisKillerCommand = defineCommand({
  name: "thesis-killer",
  type: "workflow",
  description:
    "Challenge up to five critical assumptions and identify what would invalidate your thesis",
  argumentHint:
    "Usage: <thesis>. Example: Remote work improves team productivity over three years.",
  template: "$ARGUMENTS",
  buildParts: ({ captures }) =>
    Schema.decodeUnknownEffect(thesisKillerArgs)({
      thesis: captures.$ARGUMENTS,
    }).pipe(
      Effect.map((args) => [
        {
          type: "workflow",
          workflow: "default:workflows/thesis-killer.workflow.ts",
          args,
        },
      ]),
    ),
  restoreArgumentsFromParts: Effect.fn("ThesisKillerCommand.restore")(
    function* (parts: readonly AgentPromptPartInput[]) {
      const [part] = parts;
      if (
        parts.length !== 1 ||
        part?.type !== "workflow" ||
        part.workflow !== "default:workflows/thesis-killer.workflow.ts"
      )
        return undefined;
      const args = yield* Schema.decodeUnknownEffect(thesisKillerArgs)(
        part.args,
      );
      return args.thesis;
    },
  ),
});
