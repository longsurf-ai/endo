// Purpose: Projects one model step's usage into transcript tokens and reference cost.

import type { Assistant } from "@openchart/server/agent/contracts/message";
import type { AvailableModel } from "@openchart/models/model-provider";
import type { LanguageModelUsage } from "ai";

/**
 * Converts SDK usage once for a committed step. Output includes reasoning;
 * reasoning is its breakdown and must never be charged a second time.
 *
 * ```text
 * input total  = uncached + cache read + cache write
 * output total = text + reasoning
 * context tier uses uncached + cache read for this step
 * ```
 *
 * Missing provider counts contribute zero. Missing catalog rates contribute
 * nothing to this numeric reference estimate; zero is not a billing statement.
 * Message and StepFinishPart schemas reject non-finite values at persistence.
 *
 * @example
 * const {tokens, cost} = getUsage(model, finishStep.usage);
 * yield* session.finishStep({message, part: {...step, tokens, cost}});
 */
export function getUsage(
  model: AvailableModel,
  usage: LanguageModelUsage,
): { cost: number; tokens: Assistant["tokens"] } {
  const read = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const reasoning = usage.outputTokenDetails.reasoningTokens ?? 0;
  const tokens = {
    input:
      usage.inputTokenDetails.noCacheTokens ??
      (usage.inputTokens === undefined ? 0 : usage.inputTokens - read - write),
    output:
      usage.outputTokens ??
      (usage.outputTokenDetails.textTokens ?? 0) + reasoning,
    reasoning,
    cache: { read, write },
  };

  const context = tokens.input + read;
  const tier = model.cost?.contextTiers.reduce<
    NonNullable<AvailableModel["cost"]>["contextTiers"][number] | undefined
  >(
    (selected, candidate) =>
      context > candidate.threshold &&
      (!selected || candidate.threshold > selected.threshold)
        ? candidate
        : selected,
    undefined,
  );
  const rates = tier ?? model.cost;
  const cost =
    (tokens.input * (rates?.input ?? 0) +
      tokens.output * (rates?.output ?? 0) +
      read * (rates?.cache.read ?? 0) +
      write * (rates?.cache.write ?? 0)) /
    1_000_000;
  return { cost, tokens };
}
