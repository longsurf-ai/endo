// Purpose: Runs a configurable affirmative/negative debate, then summarizes it using the parent prompt model.

import {
  agent,
  phase,
  defineWorkflow,
  Effect,
  Schema,
  textPrompt,
  type AgentResult,
} from "@openchart/workflow";

/** Arguments validated by this file before execution. */
const multiTurnDebateArgs = Schema.Struct({
  round: Schema.Int.check(Schema.isGreaterThan(0)),
  topic: Schema.String.check(Schema.isMinLength(1)),
});

/** Affirmative and negative Sessions debate using the parent model; a fresh Session summarizes every round. */
export default defineWorkflow({
  description:
    "Accepts {round: positive integer, topic: string}, a round count and any debate topic. Two agents alternate affirmative and negative arguments for the requested rounds, then a fresh Session summarizes the complete debate. All participants use the parent prompt model.",
  args: multiTurnDebateArgs,
  run: (args, { parentPrompt }) =>
    Effect.gen(function* () {
      const rounds: {
        round: number;
        affirmative: AgentResult;
        negative: AgentResult;
      }[] = [];

      for (let round = 1; round <= args.round; round++) {
        const result = yield* phase(
          `Round ${round}`,
          Effect.gen(function* () {
            const previous = rounds.at(-1);
            const affirmative = yield* agent(
              textPrompt(
                `Debate round ${round}/${args.round}. You are the affirmative side, arguing in favor of the proposition or position posed by the topic.\nTopic: ${args.topic}\nState your interpretation of the topic clearly. Support your position with reasoning and relevant evidence, address the negative side fairly, distinguish facts from assumptions and value judgments, and do not invent facts or sources. Give only your public debate statement.${round === args.round ? " This is your closing statement; include concessions and remaining disagreements." : ""}\n${previous ? `Latest negative statement:\n${previous.negative.output}` : "Open with your position and the main arguments supporting it."}`,
                parentPrompt.model,
                parentPrompt.agent,
              ),
              {
                sessionId: previous?.affirmative.sessionId,
                label: `Affirmative · round ${round}`,
              },
            );
            const negative = yield* agent(
              textPrompt(
                `Debate round ${round}/${args.round}. You are the negative side, arguing against the proposition or position posed by the topic.\nTopic: ${args.topic}\nAddress the same interpretation of the topic as the affirmative side. Challenge its reasoning and evidence, present counterarguments and relevant alternatives, distinguish facts from assumptions and value judgments, and do not invent facts or sources. Give only your public debate statement.${round === args.round ? " This is your closing statement; include concessions and remaining disagreements." : ""}\nLatest affirmative statement:\n${affirmative.output}`,
                parentPrompt.model,
                parentPrompt.agent,
              ),
              {
                sessionId: previous?.negative.sessionId,
                label: `Negative · round ${round}`,
              },
            );
            return { round, affirmative, negative };
          }),
        );
        rounds.push(result);
      }
      const transcript = rounds
        .map(
          ({ round, affirmative, negative }) =>
            `Round ${round}\nAffirmative:\n${affirmative.output}\n\nNegative:\n${negative.output}`,
        )
        .join("\n\n");
      const summary = yield* phase(
        "Synthesis",
        agent(
          textPrompt(
            `Summarize this complete ${args.round}-round affirmative/negative debate as a neutral analyst.\nTopic: ${args.topic}\nPresent each side's strongest arguments, points of agreement, unresolved disagreements, key assumptions, trade-offs, and evidence still needed. Distinguish supported facts from unverified claims and value judgments, and explain which conditions would change the conclusions. Do not invent facts or continue either participant's advocacy.\nFull debate transcript:\n${transcript}`,
            parentPrompt.model,
            parentPrompt.agent,
          ),
          { label: "Summary" },
        ),
      );
      return { topic: args.topic, rounds, summary };
    }),
});
