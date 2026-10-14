// Purpose: Classifies expected model failures for retries and transcript errors.

import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import type { Assistant } from "@openchart/server/agent/contracts/message";
import type { LLM } from "@openchart/server/agent/llm/llm";
import {
  RequestFailed,
  VariantNotFound,
} from "@openchart/server/agent/llm/errors";
import { ModelNotFound, ProviderInit } from "@openchart/server/models/errors";
import { Schema } from "effect";

/**
 * The provider stopped producing events while no tool or permission held it up.
 * @example
 * yield* Effect.fail(new StreamStalled({stallMs: 60_000}));
 */
export class StreamStalled extends Schema.TaggedError<StreamStalled>()(
  "Processor.StreamStalled",
  { stallMs: Schema.Number },
) {
  /** Explains the observed event silence without claiming a provider cause. */
  override get message() {
    return `Model stream produced no events for ${this.stallMs} ms`;
  }
}

/** Failures that Processor records; persistence failures and defects stay separate. */
export type ModelFailure = LLM.LlmError | StreamStalled;

/**
 * Narrows only known model failures, never arbitrary storage errors or defects.
 * @example
 * if (isModelFailure(error)) return toMessageError(error, model.providerID);
 */
export function isModelFailure(error: unknown): error is ModelFailure {
  return (
    error instanceof StreamStalled ||
    error instanceof RequestFailed ||
    error instanceof ModelNotFound ||
    error instanceof ProviderInit ||
    error instanceof VariantNotFound
  );
}

/**
 * Uses explicit SDK retryability and connection-reset codes. Processor must
 * also forbid replay once output has been projected or a tool has started.
 * @example
 * const retry = !projected && isRetryable(error);
 */
export function isRetryable(error: ModelFailure): boolean {
  if (error instanceof StreamStalled) return true;
  if (!(error instanceof RequestFailed)) return false;
  return APICallError.isInstance(error.cause)
    ? error.cause.isRetryable
    : isConnectionReset(error.cause);
}

/**
 * Creates a detached durable error from an expected model failure. SDK messages
 * and structured response details are retained verbatim; no response-body
 * parsing, provider-name exceptions, or message-based retry guesses occur here.
 * Interruption is owned by Effect and does not enter this conversion.
 * @example
 * const recorded = toMessageError(error, model.providerID);
 * yield* session.updateMessage({...assistant, error: recorded});
 */
export function toMessageError(
  error: ModelFailure,
  providerID: string,
): NonNullable<Assistant["error"]> {
  if (error instanceof StreamStalled) {
    return {
      name: "APIError",
      data: { message: error.message, isRetryable: true },
    };
  }
  if (error instanceof ModelNotFound) {
    return {
      name: "UnknownError",
      data: {
        message: `Model ${error.providerID}/${error.modelID} was not found`,
      },
    };
  }
  if (error instanceof VariantNotFound) {
    return {
      name: "UnknownError",
      data: {
        message: `Model ${error.providerID}/${error.modelID} does not offer variant ${error.variant}`,
      },
    };
  }

  const cause = error.cause;
  if (LoadAPIKeyError.isInstance(cause)) {
    return {
      name: "ProviderAuthError",
      data: {
        providerID:
          error instanceof ProviderInit ? error.providerID : providerID,
        message: cause.message,
      },
    };
  }
  if (APICallError.isInstance(cause)) {
    return {
      name: "APIError",
      data: {
        message: cause.message,
        statusCode: cause.statusCode,
        isRetryable: isRetryable(error),
        responseHeaders: cause.responseHeaders
          ? { ...cause.responseHeaders }
          : undefined,
        responseBody: cause.responseBody,
        metadata: { url: cause.url },
      },
    };
  }
  if (isConnectionReset(cause)) {
    return {
      name: "APIError",
      data: {
        message: cause.message,
        isRetryable: isRetryable(error),
        metadata: { code: "ECONNRESET" },
      },
    };
  }
  return {
    name: "UnknownError",
    data: {
      message:
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Model request failed without an error message",
    },
  };
}

function isConnectionReset(error: unknown): error is Error {
  return (
    error instanceof Error && "code" in error && error.code === "ECONNRESET"
  );
}
