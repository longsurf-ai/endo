// Purpose: Declares what one native CLI provider contributes to OpenChart; providers/ holds the implementations.
import type { ModelMessage } from "ai";
import type { ModelsDev } from "./catalog";
import type { AvailableModel, ModelProvider } from "./model-provider";
import type { NativeProviderID } from "./model-tiers";
import type {
  ProviderPermissionAsk,
  ProviderPermissionMode,
} from "./provider-permission";
import type { ProviderQuestionAsk } from "./provider-question";
import type { ProviderTools } from "./provider-tools";

/**
 * Shared host capabilities for one provider-managed Agent request.
 * Providers translate these into native cwd, tool, and permission options
 * passed through AI SDK `providerOptions`. Callbacks belong to this request
 * and must not be cached on the shared provider or model handle.
 * @example
 * provider.requestOptions({cwd, tools, permissionMode, askPermission});
 */
export interface ProviderRequestContext {
  /**
   * Absolute working directory resolved by the host for this request.
   * Providers pass it to the native query/thread; shared process state is unchanged.
   */
  readonly cwd: string;

  /** Application tools the native Agent may call; the adapter executes them in-process. */
  readonly tools: ProviderTools;

  /** Host configuration captured for this request; providers own native mappings. */
  readonly permissionMode: ProviderPermissionMode;

  /**
   * Asks the host to authorize a native operation. Resolves on approval;
   * rejects on refusal, failure, or cancellation. The host owns permission policy.
   * @example
   * await context.askPermission({permission: 'read', patterns: ['/notes'], metadata: {}, always: []});
   */
  readonly askPermission: ProviderPermissionAsk;
  /** Supplies user answers to a native question; omitted hosts decline questions. */
  readonly askQuestion?: ProviderQuestionAsk;
}

/**
 * One native CLI provider as OpenChart sees it: identity, the product
 * binding, and per-request translation. Implementations live under
 * `providers/<id>/`; `providers/index.ts` is the only module that lists them.
 * Root modules receive a NativeProvider as a parameter and never import one.
 * @example
 * const provider = nativeProvider(model.providerID);
 * const native = provider?.requestOptions({cwd, tools, permissionMode, askPermission});
 */
export interface NativeProvider {
  readonly id: NativeProviderID;

  /** AI SDK `providerOptions` namespace read by this provider's adapter. */
  readonly sdkKey: string;

  /** Creates the lazy product binding; construction performs no I/O. */
  createModelProvider(
    catalog: ReturnType<typeof ModelsDev.create>,
    executable: string,
  ): ModelProvider;

  /** Binds one call's cwd, tools, and approval policy; never cache the result. */
  requestOptions(context: ProviderRequestContext): Record<string, unknown>;

  /** Native defaults for a model; explicit options and the selected variant override them. */
  defaultOptions?(model: AvailableModel): Record<string, unknown>;

  /** Native transcript constraints, applied to a cloned transcript after capability filtering. */
  normalizeMessages?(messages: ModelMessage[]): ModelMessage[];
}
