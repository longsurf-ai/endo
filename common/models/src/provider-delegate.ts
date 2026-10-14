// Purpose: Maps validated delegate transport markers to processor-facing steps.
import { assertExists, assertTrue } from "@openchart/utils/assert";
import {
  PROVIDER_DELEGATE_START_STEP_KIND,
  PROVIDER_DELEGATE_FINISH_STEP_KIND,
  type OpenChartProviderMetadata,
  type ProviderMetadata,
} from "./provider-protocol";
import type { ModelStreamEvent } from "./stream";

/**
 * Projects an already parsed scoped marker without changing SDK step accounting.
 * The marker must name its delegate and cannot open one; a finish marker must
 * carry the provider's completion payload. Lifecycle ordering remains the
 * processor's responsibility.
 * @example
 * const step = conformProviderDelegateStep(kind, protocol, metadata);
 */
export function conformProviderDelegateStep(
  kind:
    | typeof PROVIDER_DELEGATE_START_STEP_KIND
    | typeof PROVIDER_DELEGATE_FINISH_STEP_KIND,
  protocol: OpenChartProviderMetadata | undefined,
  providerMetadata: ProviderMetadata | undefined,
): Extract<ModelStreamEvent, { type: "start-step" | "finish-step" }> {
  assertTrue(
    protocol?.delegateCallId !== undefined,
    "Scoped steps require delegate ownership",
  );
  assertTrue(
    protocol.openDelegate === undefined,
    "Scoped steps cannot open a delegate",
  );
  if (kind === PROVIDER_DELEGATE_START_STEP_KIND) {
    assertTrue(
      protocol?.finishDelegate === undefined,
      "Start marker cannot carry a finish payload",
    );
    return { type: "start-step", providerMetadata };
  }
  const step = protocol?.finishDelegate;
  assertExists(step, "Finish marker requires delegate completion payload");
  return { type: "finish-step", ...step, providerMetadata };
}
