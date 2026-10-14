// Purpose: Verifies bounded structured research, failure isolation, and the hypothesis race's conditional follow-up.

import { buildCommand } from "@openchart/server/agent/command/command";
import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Deferred, Effect } from "effect";
import { expect, test } from "vitest";
import { defaultWorkflowFixture } from "./defaults.test-utils";
import { run } from "./runtime";
import { Workflow } from "./workflow";

const loadDefaultWorkflow = defaultWorkflowFixture();

const thesis = "Demand will sustain growth over the next three years";
const question = "Why did the stock fall after strong earnings?";
const challenge = {
  failureMechanism: "Demand slows while supply expands",
  evidenceForAssumption: [],
  evidenceAgainstAssumption: [],
  observableSignals: ["Customer spending plans"],
  invalidationCondition: "Sustained demand contraction within three years",
  verdict: "unresolved",
  reasoning: "Primary evidence is missing",
  missingEvidence: ["Customer disclosures"],
};
const investigation = {
  supportingEvidence: [],
  opposingEvidence: [],
  assessment: "Expectations may have exceeded the reported results",
  missingEvidence: ["Pre-earnings expectations"],
};
const thesisSummary = {
  verdict: "inconclusive",
  reasoning: "The available evidence cannot resolve demand durability",
  strongestChallenge: "Demand contraction",
  conditionsToReconsider: ["Sustained demand contraction"],
  unresolvedQuestions: ["Will customers reduce spending?"],
};
const raceSummary = {
  conclusion: "Expectations remain a plausible explanation",
  comparison:
    "The evidence does not distinguish expectations from other causes",
  unresolvedQuestions: ["What had investors expected?"],
};
const followUpQuestion = "Did guidance fall below pre-earnings expectations?";

function decomposition(command: string, count: number) {
  return command === "thesis-killer"
    ? {
        assumptions: Array.from({ length: count }, (_, index) => ({
          assumption: `Critical assumption ${index + 1}`,
          whyCritical: `Thesis depends on condition ${index + 1}`,
        })),
      }
    : {
        hypotheses: Array.from({ length: count }, (_, index) => ({
          explanation: `Explanation ${index + 1}`,
          distinguishingPrediction: `Distinct observation ${index + 1}`,
        })),
      };
}

test.each([
  { command: "thesis-killer", count: 1, failed: [], followUp: false },
  { command: "thesis-killer", count: 5, failed: [1], followUp: false },
  { command: "thesis-killer", count: 1, failed: [1], followUp: false },
  { command: "hypothesis-race", count: 1, failed: [], followUp: false },
  { command: "hypothesis-race", count: 5, failed: [1], followUp: true },
  { command: "hypothesis-race", count: 1, failed: [1], followUp: false },
])(
  "$command runs $count typed investigations with failures $failed and follow-up $followUp",
  async ({ command, count, failed, followUp }) => {
    const isThesis = command === "thesis-killer";
    const model: AgentPromptInput["model"] = {
      providerID: isThesis ? "codex" : "claude-code",
      modelID: "tier4",
      selectedVariant: "high",
    };
    const initial = decomposition(command, count);
    const finalSummary = isThesis ? thesisSummary : raceSummary;
    const prompts: AgentPromptInput[] = [];
    let settled = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const parts = yield* buildCommand({
          command,
          arguments: isThesis ? thesis : question,
        });
        const part = parts[0]!;
        if (part.type !== "workflow") return yield* Effect.die("No workflow");
        const definition = yield* loadDefaultWorkflow(part.workflow);
        const allStarted = yield* Deferred.make<void>();
        return yield* run(definition, part.args).pipe(
          Effect.provideService(Workflow.Service, {
            getResource: () => Effect.die("Unexpected Resource read"),
            parentPrompt: { agent: "analyst", model, parts },
            settings: { concurrency: 5 },
            agent: (input, onSession, options) =>
              Effect.gen(function* () {
                const index = prompts.length;
                prompts.push(input);
                expect(input.model).toEqual(model);
                expect(input.agent).toBe("analyst");
                expect(options?.outputSchema).toMatchObject({ type: "object" });
                const text = input.parts.find(
                  (part) => part.type === "text",
                )!.text;
                expect(text).toContain(isThesis ? thesis : question);
                const sessionId = options?.sessionId ?? `child-${index}`;
                yield* onSession(sessionId);
                if (index === count + 3) {
                  expect(options?.sessionId).toBe(`child-${count + 1}`);
                  expect(text).toContain(JSON.stringify(investigation));
                  expect(text).toContain(followUpQuestion);
                  return { sessionId, output: JSON.stringify(finalSummary) };
                }
                expect(options?.sessionId).toBeUndefined();
                if (index === 0) {
                  expect(options?.outputSchema).toMatchObject({
                    properties: {
                      [isThesis ? "assumptions" : "hypotheses"]: {
                        minItems: 1,
                        maxItems: 5,
                      },
                    },
                  });
                  return { sessionId, output: JSON.stringify(initial) };
                }
                if (index <= count) {
                  expect(text).toContain(
                    isThesis
                      ? `Critical assumption ${index}`
                      : `Explanation ${index}`,
                  );
                  if (index === count)
                    yield* Deferred.succeed(allStarted, undefined);
                  yield* Deferred.await(allStarted);
                  settled++;
                  if (failed.includes(index))
                    return yield* Effect.fail(
                      new Error(`Research ${index} unavailable`),
                    );
                  return {
                    sessionId,
                    output: JSON.stringify(
                      isThesis ? challenge : investigation,
                    ),
                  };
                }
                expect(settled).toBe(count);
                if (index === count + 1) {
                  for (const failedIndex of failed)
                    expect(text).toContain(
                      `Research ${failedIndex} unavailable`,
                    );
                  if (failed.length < count)
                    expect(text).toContain(
                      JSON.stringify(isThesis ? challenge : investigation),
                    );
                  return {
                    sessionId,
                    output: JSON.stringify(
                      isThesis
                        ? finalSummary
                        : {
                            summary: raceSummary,
                            followUpQuestion: followUp
                              ? followUpQuestion
                              : null,
                          },
                    ),
                  };
                }
                expect(followUp).toBe(true);
                expect(index).toBe(count + 2);
                expect(text).toContain(followUpQuestion);
                return { sessionId, output: JSON.stringify(investigation) };
              }),
          }),
        );
      }).pipe(Effect.timeout("10 seconds")),
    );
    expect(prompts).toHaveLength(count + (followUp ? 4 : 2));
    expect(result).toMatchObject({
      decomposition: { output: initial },
      summary: { sessionId: `child-${count + 1}`, output: finalSummary },
    });
    if (!isThesis)
      expect(result).toMatchObject({
        followUp: followUp
          ? {
              question: followUpQuestion,
              investigation: { output: investigation },
            }
          : null,
      });
  },
);

test.each(
  ["thesis-killer", "hypothesis-race"].flatMap((command) =>
    [0, 6].map((count) => ({ command, count })),
  ),
)(
  "$command rejects $count items before research fan-out",
  async ({ command, count }) => {
    let calls = 0;
    const definition = await Effect.runPromise(
      loadDefaultWorkflow(`default:workflows/${command}.workflow.ts`),
    );
    const result = await Effect.runPromise(
      run(
        definition,
        command === "thesis-killer" ? { thesis } : { question },
      ).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt: {
            agent: "analyst",
            model: { providerID: "codex", modelID: "tier4" },
            parts: [],
          },
          settings: { concurrency: 5 },
          agent: () => {
            calls++;
            return Effect.succeed({
              sessionId: "decomposition",
              output: JSON.stringify(decomposition(command, count)),
            });
          },
        }),
        Effect.result,
      ),
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "Workflow.InvalidOutput", sessionId: "decomposition" },
    });
  },
);
