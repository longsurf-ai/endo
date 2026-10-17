// Purpose: Grok tier table: OpenChart tiers to native model identities in preference order.
import {
  TIER1,
  TIER2,
  TIER3,
  type ModelTiers,
} from "@openchart/models/model-tiers";

/**
 * Grok generations rise with capability; every plan model shares one credit
 * meter. `grok-4.7-build-fast` trades price for speed at 4.7's capability, so
 * it stays unclassified and is chosen explicitly.
 * @example resolveModelTier(GROK, TIER4, models) selects Grok 4.7, or falls downward to 4.6, 4.5.
 */
export const grokTiers: ModelTiers = {
  [TIER1]: ["grok-4.5"],
  [TIER2]: ["grok-4.6"],
  [TIER3]: ["grok-4.7"],
};
