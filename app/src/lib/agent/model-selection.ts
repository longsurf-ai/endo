// Purpose: Derive model menu visibility and resolve supported tier selections.
import { MODEL_TIER_IDS } from "@openchart/models/model-tiers";
import type {
  AgentClient,
  ModelSelection,
} from "@openchart/app/lib/agent/client";

/** Offer tiers actually present while retaining fallback choices for saved selections. @example const options = models.filter(isModelMenuOption); */
export function isModelMenuOption(model: { id: string; tier?: number }) {
  return (
    model.tier !== undefined && MODEL_TIER_IDS[model.tier - 1] === model.id
  );
}

/**
 * Uses the first visible menu option only when no preference exists. Unavailable
 * choices stay unresolved; unsupported variants retain the existing default behavior.
 * @example const model = resolveModel(providers, selection);
 */
export function resolveModel(
  providers: Awaited<ReturnType<AgentClient["models"]>>,
  preferred?: {
    providerID: string;
    modelID: string;
    selectedVariant?: string;
  } | null,
): ModelSelection | undefined {
  const available = preferred
    ? providers
        .find((provider) => provider.id === preferred.providerID)
        ?.models.find((model) => model.id === preferred.modelID)
    : providers.flatMap((provider) => provider.models).find(isModelMenuOption);
  return available
    ? {
        providerID: available.providerID,
        modelID: available.id,
        ...(preferred?.selectedVariant &&
        available.availableVariants?.includes(preferred.selectedVariant)
          ? { selectedVariant: preferred.selectedVariant }
          : {}),
      }
    : undefined;
}
