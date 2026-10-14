// Purpose: Researches a question independently n times, then synthesizes the answers.

import {
  agent,
  phase,
  defineWorkflow,
  Effect,
  parallel,
  Schema,
  textPrompt,
} from "@openchart/workflow";

/** Arguments validated by this file before execution. */
const bestOfNArgs = Schema.Struct({
  n: Schema.Int.check(Schema.isGreaterThan(0)),
  question: Schema.String.check(Schema.isMinLength(1)),
});

/** n fresh researchers followed by one fresh summarizer under the root Run. */
export default defineWorkflow({
  description:
    "Accepts {n: positive integer, question: string}. Runs n independent researchers and synthesizes the findings.",
  args: bestOfNArgs,
  run: (args, { parentPrompt }) =>
    Effect.gen(function* () {
      const research = yield* phase(
        "Research",
        parallel(
          Array.from({ length: args.n }, (_, index) =>
            agent(
              textPrompt(
                `Research attempt ${index + 1} of ${args.n}: independently investigate this question. Consider supporting evidence, counterarguments, and uncertainties.\n${args.question}`,
                parentPrompt.model,
                parentPrompt.agent,
              ),
              { label: `researcher ${index + 1}` },
            ),
          ),
        ),
      );
      const summary = yield* phase(
        "Synthesis",
        agent(
          textPrompt(
            `Synthesize these research outcomes into one answer. Distinguish evidence from uncertainty and acknowledge any failed researcher.\nQuestion: ${args.question}\nResearch outcomes:\n${JSON.stringify(research)}`,
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { label: "summarizer" },
        ),
      );
      return { research, summary };
    }),
});
