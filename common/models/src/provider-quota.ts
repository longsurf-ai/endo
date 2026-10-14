// Purpose: Defines the provider-agnostic plan quota contract that Settings renders beside each native provider.
import z from "zod";

/**
 * Provider-agnostic plan quota for one signed-in native account.
 *
 * Subscription plans meter use in windows rather than per call. Each binding
 * reads its native quota and translates it into meters; the app composes labels
 * such as "5-hour", "Weekly" or "Weekly · Fable" from the structured fields.
 * Native field names and presentation strings never appear here.
 *
 * Native mapping:
 *
 * | Native source | Meter |
 * | --- | --- |
 * | Claude `five_hour`, `seven_day` | `duration` window, `account` scope, `percent` usage |
 * | Claude `model_scoped[]` (or `seven_day_opus`/`seven_day_sonnet` when absent) | `duration` window, `model` scope named by the provider, `percent` usage |
 * | Claude `extra_usage` when enabled | `month` window, `account` scope, `spend` usage |
 * | Codex `rateLimitsByLimitId[*].primary`/`secondary` | `duration` window, `percent` usage; `model` scope when `normalModelSlug` is set |
 * | Codex `ordinaryUsageAllowed` | `blocked` |
 *
 * Quota is read-only account state. It never participates in discovery, the
 * model list, model resolution or request routing, and no layer caches it.
 * Omitted fields are unknown; zero and false are facts reported by the provider.
 */

/**
 * Period a meter counts against. `duration` is a fixed-length window such as
 * Claude's 5-hour session or Codex's `windowDurationMins`; `month` restarts each
 * billing month. The meter's `resetsAt` says when the current period ends.
 */
export const QuotaWindow = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("duration"),
      minutes: z.number().int().positive(),
    }),
    z.strictObject({ kind: z.literal("month") }),
  ])
  .readonly();

/** Quota window inferred from its owning schema. */
export type QuotaWindow = z.infer<typeof QuotaWindow>;

/**
 * Usage a meter counts. `account` counts every model on the plan. `model`
 * counts one provider-defined model bucket whose `name` is the provider's own
 * label.
 */
export const QuotaScope = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("account") }),
    z.strictObject({ kind: z.literal("model"), name: z.string().min(1) }),
  ])
  .readonly();

/** Quota scope inferred from its owning schema. */
export type QuotaScope = z.infer<typeof QuotaScope>;

/**
 * Amount a meter has used, in exactly one unit so no two values can disagree.
 * `percent` is the provider's own utilization; it may exceed 100 and renderers
 * clamp only what they draw. `spend` is money against a cap in major currency
 * units (200 means $200.00); renderers derive its fill from `used / limit`.
 */
export const QuotaUsage = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("percent"),
      usedPercent: z.number().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("spend"),
      used: z.number().nonnegative(),
      limit: z.number().positive(),
      /** ISO 4217 code, e.g. "USD". */
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
  ])
  .readonly();

/** Quota usage inferred from its owning schema. */
export type QuotaUsage = z.infer<typeof QuotaUsage>;

/**
 * One provider-reported limit on the signed-in account's plan. Meters carry no
 * ID: each read replaces the whole list, so clients key rows by position.
 */
export const QuotaMeter = z
  .strictObject({
    scope: QuotaScope,
    /** Omitted when the provider does not report the window length. */
    window: QuotaWindow.optional(),
    /** Omitted when the provider reports no usage value. */
    usage: QuotaUsage.optional(),
    /** UTC instant when the current period ends. Omitted when unknown. */
    resetsAt: z.iso.datetime().optional(),
  })
  .readonly();

/** Quota meter inferred from its owning schema. */
export type QuotaMeter = z.infer<typeof QuotaMeter>;

/**
 * One native read of a provider's plan quota.
 *
 * `not_applicable` means the native account authenticates without plan limits
 * (API key, Bedrock, Vertex); it is a fact, not a failure. Failed reads reject
 * instead of producing a status. `ready` lists meters in binding order: account
 * scope from the shortest window, then model scopes.
 */
export const ProviderQuota = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_applicable") }),
    z.strictObject({
      status: z.literal("ready"),
      /** Native plan name as reported, e.g. "max" or "pro"; the app owns display casing. */
      plan: z.string().min(1).optional(),
      /**
       * Provider-reported refusal of ordinary plan usage. Omitted when unknown;
       * never inferred from percentages or reset times.
       */
      blocked: z.boolean().optional(),
      meters: z.array(QuotaMeter).readonly(),
    }),
  ])
  .readonly();

/** Provider quota inferred from its owning schema. */
export type ProviderQuota = z.infer<typeof ProviderQuota>;
