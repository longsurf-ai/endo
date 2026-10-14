// Purpose: Defines native CLI provider discovery and access through the standard AI SDK contract.

import type { ProviderV4 } from "@ai-sdk/provider";
import z from "zod";
import type { ProviderQuota } from "./provider-quota";

/**
 * Public model metadata for selection, capability checks, and usage budgeting.
 *
 * [models.dev](https://models.dev) supplies catalog JSON; its schema lives in
 * the private @models.dev/core workspace package. We define this public
 * projection locally to keep catalog transport settings internal. Native
 * discovery determines availability; models.dev enriches discovered models.
 *
 * Discovery pipeline:
 *
 * ```text
 * Provider native discovery
 *            |
 *            v
 * Enrich model metadata <--- models.dev
 *            |
 *            v
 * Group by tier <----------- binding mapping + preference order
 *            |
 *            v
 * Tier 1 | Tier 2 | ... | Unclassified
 * ```
 *
 * Field ownership:
 *
 * | Source | Fields |
 * | --- | --- |
 * | Binding identity | `kind`, `providerID` |
 * | Native discovery | `id`, `name`, optional `description`, known `availableVariants` |
 * | Native discovery + models.dev | `capabilities` |
 * | models.dev enrichment | `cost`, `limit` |
 * | Binding mapping + preference order | `tier` |
 *
 * Codex supplies `model`, `displayName`, and
 * `supportedReasoningEfforts[].reasoningEffort`; Claude Code supplies `value`,
 * `displayName`, and `supportedEffortLevels`. Claude's `resolvedModel` can match
 * catalog metadata, but never replaces the selected `value` as the SDK id.
 * Missing native metadata does not establish an unsupported capability.
 *
 * Only language discovery is defined; other kinds add their own metadata branches.
 * The kind selects an SDK model API, independently of input/output modalities.
 * The id is passed directly to the binding's SDK; implementation settings and
 * native variant parameters never enter discovery results.
 */
export const AvailableModel = z
  .strictObject({
    kind: z.literal("language"),
    id: z.string(),
    /** Native canonical identities used only for tier recognition, never SDK routing. */
    aliases: z.array(z.string()).readonly().optional(),
    providerID: z.string(),
    name: z.string(),
    /** Native picker description, when supplied; may include the model version. */
    description: z.string().optional(),

    /**
     * Assigned by the binding's ordered model mapping. Higher numbers indicate
     * higher capability tiers within this provider and model kind.
     * Omitted means unclassified: discovery and direct model access remain
     * available, while selection by tier excludes this model.
     */
    tier: z.number().int().positive().optional(),

    // Omitted capability facts are unknown; false means known unsupported.
    capabilities: z.object({
      temperature: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      attachment: z.boolean().optional(),
      toolcall: z.boolean().optional(),
      input: z
        .object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        })
        .partial(),
      output: z
        .object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        })
        .partial(),
    }),
    // Catalog reference prices, not account billing. Omitted prices are unknown.
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number().optional(),
          write: z.number().optional(),
        }),
        contextTiers: z
          .array(
            z.object({
              threshold: z.number().int().positive(),
              input: z.number(),
              output: z.number(),
              cache: z.object({
                read: z.number().optional(),
                write: z.number().optional(),
              }),
            }),
          )
          .readonly(),
      })
      .optional(),
    // Omitted means no matching catalog limit is known.
    limit: z
      .object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      })
      .optional(),
    /**
     * Selectable variant names. Omitted means unknown; an empty array means
     * there are no selectable variants. Missing native effort metadata must
     * never become an empty list by default.
     */
    availableVariants: z.array(z.string()).readonly().optional(),
  })
  .readonly();

/** Public model data inferred from its owning schema. */
export type AvailableModel = z.infer<typeof AvailableModel>;

/**
 * A product-supported provider available in the current environment.
 * The binding assigns provider id and name; native discovery supplies models.
 * Models belong to this provider and have unique IDs within each model kind.
 */
export const AvailableProvider = z
  .strictObject({
    /**
     * Provider ID assigned by the binding, e.g. "claude-code".
     * Each model references this ID through providerID.
     */
    id: z.string(),

    /** Provider display name, e.g. 'Claude Code'. */
    name: z.string(),

    models: z.array(AvailableModel).readonly(),
  })
  .readonly();

/** Public provider data inferred from its owning schema. */
export type AvailableProvider = z.infer<typeof AvailableProvider>;

/** Native readiness of the host-selected runtime. Onboarding owns installation/version pins.
 * Discovery never downloads or signs in; native credentials stay with the CLI.
 */
export const ProviderDiscoveryResult = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_installed") }),
    z.strictObject({
      status: z.literal("authentication_required"),
      /**
       * Official login command for the detected CLI. The host runs it in an
       * interactive process after explicit user action, passing args separately
       * without constructing a shell command, with piped stdin and output. The
       * native CLI owns login.
       */
      login: z
        .strictObject({
          /**
           * Absolute path: the managed CLI supplied by the host, or a fixed
           * system program such as `/bin/bash` that runs it in a
           * pseudo-terminal when the CLI signs in only from a terminal.
           */
          executable: z.string().min(1),
          /** Native login arguments, e.g. ["login"] or ["auth", "login"]. */
          args: z.array(z.string()).readonly(),
        })
        .readonly(),
    }),
    // All applicable checks passed and model discovery completed.
    z.strictObject({
      status: z.literal("ready"),
      provider: AvailableProvider,
    }),
  ])
  .readonly();

/** Public discovery result inferred from its owning schema. */
export type ProviderDiscoveryResult = z.infer<typeof ProviderDiscoveryResult>;

/**
 * Product binding for native CLI discovery and standard AI SDK model construction.
 * The binding owns SDK configuration, native request translation, and lifecycle.
 * Request-scoped MCP servers and permission callbacks enter through call options.
 */
export interface ModelProvider {
  /**
   * Stable provider ID assigned by the binding, even while unavailable.
   * A ready result's provider ID and every model's providerID must match this ID.
   * Reading it performs no I/O.
   */
  readonly id: string;

  /**
   * Checks the current environment independently of application enablement and
   * returns models or an explicit setup requirement. Checks installation
   * and required native authentication before discovering models.
   * Does not install, upgrade, start login, or open a browser. Authentication
   * requirements include a command for the host to run interactively after user
   * action. Check failures reject the promise; an unknown version or failed auth
   * check is not a setup requirement.
   * Ready model IDs identify models in the corresponding SDK model API. The
   * binding retains ownership of its SDK and shared resources until dispose().
   *
   * @example
   * ```ts
   * const result = await provider.discover();
   * if (result.status === 'ready') {
   *   const model = result.provider.models.find(model => model.kind === 'language');
   *   if (model) {
   *     const language = provider.sdk.languageModel(model.id);
   *   }
   * }
   * ```
   */
  discover(): Promise<ProviderDiscoveryResult>;

  /**
   * Reads the signed-in account's current plan quota from the native provider,
   * independently of application enablement. Every call reads native state
   * again; the binding keeps no quota cache, and quota never feeds discovery.
   * Does not install, upgrade, start login, or change native settings. Accounts
   * whose native authentication has no plan limits resolve `not_applicable`.
   * A missing executable, a signed-out account, or a failed native read rejects.
   *
   * @example
   * ```ts
   * const quota = await provider.readQuota();
   * if (quota.status === 'ready') {
   *   for (const meter of quota.meters) console.log(meter.scope, meter.usage);
   * }
   * ```
   */
  readQuota(): Promise<ProviderQuota>;

  /**
   * Standard model factories for every model kind supported by the SDK.
   * Discovery advertises supported models; a factory's presence alone does
   * not imply that this provider supports that model kind.
   */
  readonly sdk: ProviderV4;

  /**
   * Releases this instance's native process and shared resources. Idempotent;
   * further discovery and model use fail. The owning service disposes instances
   * when its scope ends or configuration changes. This may interrupt active calls;
   * completing one request never disposes its shared binding.
   * @example
   * try { await provider.discover(); } finally { await provider.dispose(); }
   */
  dispose(): Promise<void>;
}
