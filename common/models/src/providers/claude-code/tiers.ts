// Purpose: Claude Code tier table: OpenChart tiers to native model identities in preference order.
import {
  TIER1,
  TIER2,
  TIER3,
  TIER4,
  type ModelTiers,
} from "@openchart/models/model-tiers";

/** @example resolveModelTier(CLAUDE_CODE, TIER4, models) prefers fable[1m], then falls to Opus, Sonnet, Haiku. */
export const claudeCodeTiers: ModelTiers = {
  [TIER1]: ["haiku", "claude-haiku-4-5-20251001"],
  [TIER2]: ["sonnet", "claude-sonnet-5-5", "claude-sonnet-5"],
  [TIER3]: [
    "opus[1m]",
    "opus",
    "claude-opus-5-5[1m]",
    "claude-opus-5-5",
    "claude-opus-5[1m]",
    "claude-opus-5",
  ],
  [TIER4]: [
    "fable[1m]",
    "fable",
    "claude-fable-5-1",
    "claude-fable-5-1[1m]",
    "claude-fable-5[1m]",
    "claude-fable-5",
  ],
};
