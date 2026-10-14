// Purpose: Codex tier table: OpenChart tiers to native model identities in preference order.
import {
  TIER1,
  TIER2,
  TIER3,
  TIER4,
  type ModelTiers,
} from "@openchart/models/model-tiers";

/** @example resolveModelTier(CODEX, TIER4, models) selects Astra, or falls downward to Sol, Terra, Luna. */
export const codexTiers: ModelTiers = {
  [TIER1]: ["gpt-6-luna", "gpt-5.6-luna"],
  [TIER2]: ["gpt-5.6-terra"],
  [TIER3]: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"],
  [TIER4]: ["gpt-6-astra"],
};
