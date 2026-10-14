// Purpose: Projects catalog enrichment shared by native provider bindings without inventing availability.
import type { ModelsDev } from "@openchart/models/catalog";
import type { AvailableModel } from "@openchart/models/model-provider";

/**
 * Projects a known modality set; omission means unknown, not unsupported.
 * @example
 * const input = modelModalities(['text', 'image']);
 */
export function modelModalities(
  values: readonly string[] | undefined,
): AvailableModel["capabilities"]["input"] {
  if (values === undefined) return {};
  return {
    text: values.includes("text"),
    audio: values.includes("audio"),
    image: values.includes("image"),
    video: values.includes("video"),
    pdf: values.includes("pdf"),
  };
}

/**
 * Enriches an already discovered model. Unknown prices, limits, and capabilities
 * stay omitted; API reference prices never imply a CLI account's actual bill.
 * Native identities and variants remain the binding's responsibility.
 * @example
 * const metadata = catalogModelMetadata(catalog.anthropic?.models[resolvedID]);
 */
export function catalogModelMetadata(
  model: ModelsDev.Model | undefined,
): Pick<AvailableModel, "capabilities" | "cost" | "limit"> {
  const price = model?.cost;
  return {
    capabilities: {
      temperature: model?.temperature,
      reasoning: model?.reasoning,
      attachment: model?.attachment,
      toolcall: model?.tool_call,
      input: modelModalities(model?.modalities?.input),
      output: modelModalities(model?.modalities?.output),
    },
    cost: price && {
      input: price.input,
      output: price.output,
      cache: { read: price.cache_read, write: price.cache_write },
      contextTiers: (
        price.tiers ??
        (price.context_over_200k
          ? [
              {
                ...price.context_over_200k,
                tier: { type: "context" as const, size: 200_000 },
              },
            ]
          : [])
      )
        .map((tier) => ({
          threshold: tier.tier.size,
          input: tier.input,
          output: tier.output,
          cache: { read: tier.cache_read, write: tier.cache_write },
        }))
        .sort((left, right) => left.threshold - right.threshold),
    },
    limit: model && { ...model.limit },
  };
}
