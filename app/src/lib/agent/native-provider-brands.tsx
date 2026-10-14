// Purpose: Name and mark each native provider once for every app surface.
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  type NativeProviderID,
} from "@openchart/models/model-tiers";
import type { ComponentType } from "react";
import {
  ClaudeLogo,
  OpenAILogo,
  type LogoProps,
} from "@openchart/app/components/ui/model-selector/logos";
import { AntigravityLogo } from "@openchart/app/components/ui/brand/antigravity-logo";

/** A provider's display identity; `agent` names it in prose such as "Analyze with Claude". */
export interface NativeProviderBrand {
  readonly name: string;
  readonly agent: string;
  readonly Logo: ComponentType<LogoProps>;
}

/**
 * Every supported provider's name and mark, keyed by provider ID so a new
 * provider fails to compile until it is named here.
 * @example
 * const { name, Logo } = NATIVE_PROVIDER_BRANDS[providerID];
 */
export const NATIVE_PROVIDER_BRANDS: Readonly<
  Record<NativeProviderID, NativeProviderBrand>
> = {
  [CODEX]: { name: "Codex", agent: "Codex", Logo: OpenAILogo },
  [CLAUDE_CODE]: { name: "Claude Code", agent: "Claude", Logo: ClaudeLogo },
  [ANTIGRAVITY]: {
    name: "Antigravity",
    agent: "Antigravity",
    Logo: AntigravityLogo,
  },
};

/**
 * Brands a provider ID received as data; IDs outside the supported set have none.
 * @example const Logo = nativeProviderBrand(provider.id)?.Logo;
 */
export function nativeProviderBrand(
  providerID: string,
): NativeProviderBrand | undefined {
  return Object.hasOwn(NATIVE_PROVIDER_BRANDS, providerID)
    ? NATIVE_PROVIDER_BRANDS[providerID as NativeProviderID]
    : undefined;
}
