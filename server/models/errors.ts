// Purpose: Defines expected model resolution failures at the Effect boundary.

import { Schema } from "effect";

/**
 * A provider or model identifier could not be resolved.
 *
 * @example
 * ```ts
 * yield* models.getModel(CODEX, 'missing').pipe(
 *   Effect.catchTag('Models.NotFound', error => Effect.log(error.modelID)),
 * );
 * ```
 */
export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()(
  "Models.NotFound",
  {
    providerID: Schema.String,
    modelID: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Discovery or initialization of a provider failed before a model could be used.
 *
 * @example
 * ```ts
 * yield* models.getLanguage(model).pipe(
 *   Effect.catchTag('Models.ProviderInit', error => Effect.log(error.cause)),
 * );
 * ```
 */
export class ProviderInit extends Schema.TaggedError<ProviderInit>()(
  "Models.ProviderInit",
  { providerID: Schema.String, cause: Schema.Defect() },
) {}

/** Model settings could not be read; callers must not silently use stale settings. */
export class ConfigurationUnavailable extends Schema.TaggedError<ConfigurationUnavailable>()(
  "Models.ConfigurationUnavailable",
  { cause: Schema.Defect() },
) {}

/**
 * A provider's plan quota could not be read. Separate from {@link ProviderInit}:
 * a failed quota read never makes the provider or its models unavailable.
 *
 * @example
 * ```ts
 * yield* models.quota(CODEX).pipe(
 *   Effect.catchTag('Models.QuotaUnavailable', error => Effect.log(error.cause)),
 * );
 * ```
 */
export class QuotaUnavailable extends Schema.TaggedError<QuotaUnavailable>()(
  "Models.QuotaUnavailable",
  { providerID: Schema.String, cause: Schema.Defect() },
) {}

/** Expected failures from model lookup and provider construction. */
export type ModelError =
  ModelNotFound | ProviderInit | ConfigurationUnavailable;
