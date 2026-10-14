// Purpose: Defines expected failures of one prepared LLM request.

import { Schema } from "effect";

/** An explicit request variant was not advertised by the resolved model. */
export class VariantNotFound extends Schema.TaggedError<VariantNotFound>()(
  "LLM.VariantNotFound",
  { providerID: Schema.String, modelID: Schema.String, variant: Schema.String },
) {}

/** A request callback or provider reported a failure; the original cause is retained. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()(
  "LLM.RequestFailed",
  { cause: Schema.Defect() },
) {}

/** Model arguments failed encoded-side validation before tool execution. */
export class InvalidToolArguments extends Schema.TaggedError<InvalidToolArguments>()(
  "LLM.InvalidToolArguments",
  { toolID: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** A provider requested permission without an application permission callback. */
export class PermissionUnavailable extends Schema.TaggedError<PermissionUnavailable>()(
  "LLM.PermissionUnavailable",
  {},
) {
  /** Explains why the provider request cannot obtain permission. */
  override get message() {
    return "Provider permission context is unavailable";
  }
}
