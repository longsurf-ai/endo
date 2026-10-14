// Purpose: Owns provider identities, logical model IDs, and tier classification and selection.

import z from "zod";
import type { AvailableModel } from "./model-provider";

/** Codex provider identity. */
export const CODEX = "codex" as const;
/** Claude Code provider identity. */
export const CLAUDE_CODE = "claude-code" as const;
/** Antigravity CLI provider identity. */
export const ANTIGRAVITY = "antigravity" as const;

/** Providers accepted by product prompts and model selectors. */
export const MODEL_PROVIDER_IDS = [CODEX, CLAUDE_CODE, ANTIGRAVITY] as const;

/** Supported native provider identity, independent of enablement and discovery. */
export type NativeProviderID = (typeof MODEL_PROVIDER_IDS)[number];

/** Lowest model tier; never falls back upward. */
export const TIER1 = "tier1" as const;
/** Tier 2, falling back through tier 1. */
export const TIER2 = "tier2" as const;
/** Tier 3, falling back through tier 1. */
export const TIER3 = "tier3" as const;
/** Tier 4, falling back through tier 1. */
export const TIER4 = "tier4" as const;
/** Tier 5, falling back through tier 1. */
export const TIER5 = "tier5" as const;

/** Logical model IDs in ascending fallback order. */
export const MODEL_TIER_IDS = [TIER1, TIER2, TIER3, TIER4, TIER5] as const;
/** Recognizes logical tier IDs; other model references remain explicit SDK IDs. */
export const ModelTier = z.enum(MODEL_TIER_IDS);
/** Logical model identity derived from its boundary schema. */
export type ModelTier = z.infer<typeof ModelTier>;

/**
 * One provider's tier table: OpenChart tiers to native model identities.
 * Each provider maintains its own table in `providers/<id>/tiers.ts`.
 *
 * Higher tier numbers mean higher capability within a provider, not equivalent
 * capability across providers. Each array lists candidates in preference order:
 * aliases, model versions, and context variants can share a tier without being
 * interchangeable. Match discovered IDs/aliases exactly and preserve the native
 * discovered ID when calling the SDK.
 *
 * A table classifies models; native discovery alone establishes availability.
 * A missing tier has no model of its own. Menus show only tiers actually present,
 * never inventing a higher tier because a lower one could satisfy its request.
 *
 * For tier inputs, {@link resolveModelTier} tries the requested tier, then lower
 * tiers within the same provider (tier4 -> tier3 -> tier2 -> tier1). No upward or
 * cross-provider fallback; no candidate means resolution fails. Explicit model
 * IDs remain valid inputs and match discovery exactly, without tier fallback.
 * Unlisted discovered models remain usable explicitly, but cannot satisfy tiers.
 *
 * @example const tiers: ModelTiers = { [TIER1]: ["haiku"], [TIER2]: ["sonnet"] };
 */
export type ModelTiers = Partial<Record<ModelTier, readonly string[]>>;

/**
 * Classifies exact discovered identities against one provider's tier table and
 * sorts by descending tier/preference. Canonical aliases aid recognition; the
 * SDK ID and native metadata stay intact. Unknown models retain their native
 * order after classified models.
 * @example const models = classifyModels(codexTiers, discovered);
 */
export function classifyModels(
  tiers: ModelTiers,
  models: readonly AvailableModel[],
): AvailableModel[] {
  return models
    .map((model) => {
      for (const id of [model.id, ...(model.aliases ?? [])]) {
        for (const [index, tier] of MODEL_TIER_IDS.entries()) {
          const preference = tiers[tier]?.indexOf(id) ?? -1;
          if (preference >= 0)
            return { model: { ...model, tier: index + 1 }, preference };
        }
      }
      return { model: { ...model, tier: undefined }, preference: 0 };
    })
    .sort(
      (left, right) =>
        (right.model.tier ?? 0) - (left.model.tier ?? 0) ||
        left.preference - right.preference,
    )
    .map(({ model }) => model);
}

/**
 * Selects the highest available tier at or below the request, within one provider.
 * Input is classified discovery in preference order; unknown models never substitute.
 * Returns undefined when no candidate exists, without mutating discovery or doing I/O.
 * @example const model = resolveModelTier(CODEX, TIER4, providers[0].models);
 */
export function resolveModelTier(
  providerID: string,
  modelID: ModelTier,
  models: readonly AvailableModel[],
): AvailableModel | undefined {
  for (let tier = MODEL_TIER_IDS.indexOf(modelID) + 1; tier > 0; tier--) {
    const model = models.find(
      (candidate) =>
        candidate.providerID === providerID && candidate.tier === tier,
    );
    if (model) return model;
  }
  return undefined;
}

/**
 * Projects supported providers into tier-only picker choices, including downward fallbacks.
 * Tier choices retain the resolved model's native name and metadata.
 * Execution resolves the ID again; menus can use the actual tier to hide absent tiers.
 * @example const choices = providers.flatMap(modelChoices);
 */
export function modelChoices(provider: {
  readonly id: string;
  readonly name: string;
  readonly models: readonly AvailableModel[];
}) {
  const providerID = MODEL_PROVIDER_IDS.find((id) => id === provider.id);
  if (!providerID) return [];
  return [
    {
      id: providerID,
      name: provider.name,
      models: [...MODEL_TIER_IDS].reverse().flatMap((id) => {
        const model = resolveModelTier(providerID, id, provider.models);
        if (!model) return [];
        return [{ ...model, providerID, id }];
      }),
    },
  ];
}
