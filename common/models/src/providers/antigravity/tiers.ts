// Purpose: Antigravity tier table: OpenChart tiers to native model identities in preference order.
import {
  TIER1,
  TIER2,
  TIER3,
  TIER4,
  TIER5,
  type ModelTiers,
} from "@openchart/models/model-tiers";

/**
 * Gemini models share one plan bucket and Claude models another; free plans
 * offer only Gemini, so higher tiers fall back to Gemini 3.1 Pro. Gemini 4
 * Argon is Google's flagship and sits above Claude Opus; plans without it
 * fall back to Opus, and Pro plans meter it in its own weekly bucket.
 * @example resolveModelTier(ANTIGRAVITY, TIER5, models) prefers Gemini 4 Argon, then Claude Opus, Sonnet, Gemini Pro, Flash.
 */
export const antigravityTiers: ModelTiers = {
  [TIER1]: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
  [TIER2]: ["gemini-3.1-pro"],
  [TIER3]: ["claude-sonnet-5-5"],
  [TIER4]: ["claude-opus-5-5"],
  [TIER5]: ["gemini-4-argon"],
};
