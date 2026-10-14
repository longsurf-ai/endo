// Purpose: Lists the native providers OpenChart ships; the only module that names more than one.
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  type NativeProviderID,
} from "@openchart/models/model-tiers";
import type { NativeProvider } from "@openchart/models/native-provider";
import { antigravity } from "./antigravity/binding";
import { claudeCode } from "./claude-code/binding";
import { codex } from "./codex/binding";

/** Every supported native provider by ID; hosts construct bindings from here. */
export const NATIVE_PROVIDERS: Readonly<
  Record<NativeProviderID, NativeProvider>
> = {
  [CLAUDE_CODE]: claudeCode,
  [CODEX]: codex,
  [ANTIGRAVITY]: antigravity,
};

/**
 * Looks up the native provider behind a model; plain AI SDK providers have none.
 * @example
 * const provider = nativeProvider(model.providerID);
 * if (provider) options = provider.requestOptions(context);
 */
export function nativeProvider(providerID: string): NativeProvider | undefined {
  return Object.hasOwn(NATIVE_PROVIDERS, providerID)
    ? NATIVE_PROVIDERS[providerID as NativeProviderID]
    : undefined;
}
