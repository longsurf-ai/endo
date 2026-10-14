// Purpose: Challenges up to five critical assumptions and reviews observable thesis invalidation conditions.

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
const thesisKillerArgs = Schema.Struct({ thesis: Text });

const Decomposition = Schema.Struct({
  assumptions: Schema.Array(
    Schema.Struct({ assumption: Text, whyCritical: Text }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
const Evidence = Schema.Struct({ finding: Text, sourceUrl: Text });
const Challenge = Schema.Struct({
  failureMechanism: Text,
  evidenceForAssumption: Schema.Array(Evidence),
  evidenceAgainstAssumption: Schema.Array(Evidence),
  observableSignals: Schema.Array(Text),
  invalidationCondition: Text,
  verdict: Schema.Literals(["challenged", "survived", "unresolved"]),
  reasoning: Text,
  missingEvidence: Schema.Array(Text),
});
const Summary = Schema.Struct({
  verdict: Schema.Literals(["vulnerable", "survived", "inconclusive"]),
  reasoning: Text,
  strongestChallenge: Text,
  conditionsToReconsider: Schema.Array(Text).check(Schema.isMaxLength(5)),
  unresolvedQuestions: Schema.Array(Text),
});

/** Decomposes, challenges in parallel, and independently reviews using typed child outputs. */
export default defineWorkflow({
  description:
    "Accepts {thesis: string}. Decomposes a thesis into one to five critical assumptions, challenges each with evidence and observable invalidation conditions, then independently reviews the findings. Every stage uses structured output and the parent prompt model.",
  args: thesisKillerArgs,
  run: ({ thesis }, { parentPrompt }) =>
    Effect.gen(function* () {
      const context = [
        `Thesis: ${thesis}`,
        "Respect the user's language, scope, and time horizon. Preserve the strongest fair interpretation of the thesis; distinguish empirical assumptions from preferences and value judgments.",
        "Use available research tools to verify factual claims. Prefer primary sources with dates and comparable periods. Cite actual source URLs; never invent sources, facts, or numerical thresholds. Keep unsupported scenarios separate from observed evidence. Leave evidence arrays empty when sources are unavailable and explain the gap.",
      ].join("\n\n");
      const decomposition = yield* phase(
        "Identify assumptions",
        agent(
          textPrompt(
            `Identify one to five distinct assumptions essential to this thesis, ordered by importance. Use fewer when sufficient; do not pad the list. Explain why failure of each assumption would materially weaken the thesis.\n\n${context}`,
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { schema: Decomposition, label: "Critical assumptions" },
        ),
      );
      const outcomes = yield* phase(
        "Challenge assumptions",
        parallel(
          decomposition.output.assumptions.map((assumption, index) =>
            agent(
              textPrompt(
                [
                  "Stress-test this assumption. Find the strongest plausible failure mechanism and actively seek both supporting and opposing evidence. Describe observable signals and a concrete falsification condition, including its time horizon where relevant. If no defensible test is available, say so explicitly instead of inventing a threshold.",
                  "A hypothetical failure is not evidence that failure has occurred. Use challenged only for a material evidence-backed challenge, survived only for the checks actually performed, and unresolved when evidence is insufficient.",
                  context,
                  `Assumption ${index + 1}: ${JSON.stringify(assumption)}`,
                ].join("\n\n"),
                parentPrompt.model,
                parentPrompt.agent,
              ),
              { schema: Challenge, label: `Challenge assumption ${index + 1}` },
            ),
          ),
        ),
      );
      const challenges = decomposition.output.assumptions.map(
        (assumption, index) => ({ ...assumption, outcome: outcomes[index]! }),
      );
      const summary = yield* phase(
        "Review thesis",
        agent(
          textPrompt(
            [
              "Independently review these challenges. Check whether each proposed invalidation condition is observable and would actually change the thesis, rather than merely describe ordinary volatility or an unrelated risk. Identify the strongest challenge and at most five defensible conditions for reconsideration, prioritized by importance. Preserve useful source URLs in your reasoning.",
              "Do not force a rejection. Distinguish an already contradicted assumption from a future failure scenario. Failed investigations and missing evidence are unresolved, never proof that the thesis survived. If all investigations failed, return inconclusive. Survived means only that the performed checks did not overturn the thesis.",
              context,
              `Challenge outcomes: ${JSON.stringify(challenges)}`,
            ].join("\n\n"),
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { schema: Summary, label: "Thesis review" },
        ),
      );
      return { thesis, decomposition, challenges, summary };
    }),
});
