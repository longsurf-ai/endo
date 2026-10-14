// Purpose: Compares up to five explanations and optionally investigates one discriminating question.

import {
  agent,
  phase,
  defineWorkflow,
  Effect,
  parallel,
  Schema,
  textPrompt,
} from "@openchart/workflow";

const Text = Schema.String.check(Schema.isPattern(/\S/));

/** Arguments validated by this file before execution. */
const hypothesisRaceArgs = Schema.Struct({ question: Text });

const Decomposition = Schema.Struct({
  hypotheses: Schema.Array(
    Schema.Struct({ explanation: Text, distinguishingPrediction: Text }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
const Evidence = Schema.Struct({ finding: Text, sourceUrl: Text });
const Investigation = Schema.Struct({
  supportingEvidence: Schema.Array(Evidence),
  opposingEvidence: Schema.Array(Evidence),
  assessment: Text,
  missingEvidence: Schema.Array(Text),
});
const Summary = Schema.Struct({
  conclusion: Text,
  comparison: Text,
  unresolvedQuestions: Schema.Array(Text),
});
const Review = Schema.Struct({
  summary: Summary,
  followUpQuestion: Schema.NullOr(Text),
});

/** Uses typed hypotheses for fan-out and one optional, reviewer-selected follow-up. */
export default defineWorkflow({
  description:
    "Accepts {question: string}. Generates one to five competing explanations, investigates each in parallel, and compares the evidence. A reviewer may request one discriminating follow-up before its final assessment. Every stage uses structured output and the parent prompt model.",
  args: hypothesisRaceArgs,
  run: ({ question }, { parentPrompt }) =>
    Effect.gen(function* () {
      const context = [
        `Question: ${question}`,
        "Respect the user's language, scope, and time horizon. Verify the premise rather than assuming the event or causal relationship is established.",
        "Use available research tools, prefer dated primary sources, and cite actual source URLs. Do not invent facts or sources. Distinguish observations from interpretations; correlation alone is not causation. Leave evidence arrays empty when sources are unavailable and explain the gap.",
      ].join("\n\n");
      const decomposition = yield* phase(
        "Develop hypotheses",
        agent(
          textPrompt(
            `Generate one to five distinct, plausible explanations for the question. Use fewer when sufficient; do not pad the list. For each, specify an observable prediction that could distinguish it from the alternatives. Consider a mistaken premise when appropriate.\n\n${context}`,
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { schema: Decomposition, label: "Competing hypotheses" },
        ),
      );
      const hypotheses = decomposition.output.hypotheses;
      const outcomes = yield* phase(
        "Investigate hypotheses",
        parallel(
          hypotheses.map((hypothesis, index) =>
            agent(
              textPrompt(
                [
                  "Investigate the assigned explanation independently. Actively seek supporting and opposing evidence, test its distinguishing prediction, and identify evidence that favors it over the alternatives. Do not advocate for your assignment or treat missing evidence as refutation.",
                  context,
                  `All hypotheses: ${JSON.stringify(hypotheses)}`,
                  `Assigned hypothesis ${index + 1}: ${JSON.stringify(hypothesis)}`,
                ].join("\n\n"),
                parentPrompt.model,
                parentPrompt.agent,
              ),
              {
                schema: Investigation,
                label: `Investigate hypothesis ${index + 1}`,
              },
            ),
          ),
        ),
      );
      const research = hypotheses.map((hypothesis, index) => ({
        ...hypothesis,
        outcome: outcomes[index]!,
      }));
      const review = yield* phase(
        "Compare evidence",
        agent(
          textPrompt(
            [
              "Compare all explanations as a neutral reviewer. Explain which evidence distinguishes them, which have weakened, and which remain plausible. Multiple causes may coexist; do not force a winner or fabricate probabilities. Repeated claims from one source are not independent corroboration. Preserve useful source URLs. Failed investigations remain unresolved, never rejected by default; if all failed, say evidence is insufficient.",
              "Return your current summary. Set followUpQuestion to the single answerable question most likely to change the relative assessment, or null if no useful additional investigation is warranted. Only one follow-up investigation is available.",
              context,
              `Research outcomes: ${JSON.stringify(research)}`,
            ].join("\n\n"),
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { schema: Review, label: "Compare hypotheses" },
        ),
      );
      if (review.output.followUpQuestion === null)
        return {
          question,
          decomposition,
          research,
          followUp: null,
          summary: {
            sessionId: review.sessionId,
            output: review.output.summary,
          },
        };

      const followUp = yield* phase(
        "Follow-up investigation",
        agent(
          textPrompt(
            [
              "Investigate this discriminating question. Seek evidence supporting and opposing its premise, explain what the observations imply for each competing explanation, and state what remains unknown.",
              context,
              `All hypotheses: ${JSON.stringify(hypotheses)}`,
              `Current research: ${JSON.stringify(research)}`,
              `Follow-up question: ${review.output.followUpQuestion}`,
            ].join("\n\n"),
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { schema: Investigation, label: "Discriminating investigation" },
        ),
      );
      const summary = yield* phase(
        "Final assessment",
        agent(
          textPrompt(
            [
              "Give your final comparative assessment using the original research and this follow-up. Explain whether and why the new evidence changes your conclusion, preserve source URLs, and retain unresolved alternatives and questions. Do not force a winner. This is the final review; request no further investigation.",
              context,
              `Follow-up question: ${review.output.followUpQuestion}`,
              `Follow-up findings: ${JSON.stringify(followUp.output)}`,
            ].join("\n\n"),
            parentPrompt.model,
            parentPrompt.agent,
          ),
          {
            schema: Summary,
            sessionId: review.sessionId,
            label: "Final comparison",
          },
        ),
      );
      return {
        question,
        decomposition,
        research,
        followUp: {
          question: review.output.followUpQuestion,
          investigation: followUp,
        },
        summary,
      };
    }),
});
