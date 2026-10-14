// Purpose: Verifies expected model-error projection without widening retry policy.

import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import {
  RequestFailed,
  VariantNotFound,
} from "@openchart/server/agent/llm/errors";
import { ModelNotFound, ProviderInit } from "@openchart/server/models/errors";
import { describe, expect, test } from "vitest";
import {
  StreamStalled,
  isModelFailure,
  isRetryable,
  toMessageError,
} from "./errors";

describe("processor model failures", () => {
  test("preserves structured SDK response data without sharing mutable headers", () => {
    const cause = new APICallError({
      message: "Too Many Requests",
      url: "https://provider.example/model",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": "2" },
      responseBody: '{"error":{"message":"quota reached"}}',
    });
    const failure = new RequestFailed({ cause });
    const result = toMessageError(failure, "test");

    expect(isRetryable(failure)).toBe(true);
    expect(result).toEqual({
      name: "APIError",
      data: {
        message: cause.message,
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { "retry-after": "2" },
        responseBody: cause.responseBody,
        metadata: { url: cause.url },
      },
    });
    if (result.name !== "APIError") throw new Error("Expected APIError");
    expect(result.data.responseHeaders).not.toBe(cause.responseHeaders);
  });

  test("does not recreate V1 OpenAI 404 or error-message retry heuristics", () => {
    const failures = [
      new RequestFailed({
        cause: new APICallError({
          message: "Not Found",
          url: "https://api.openai.com/model",
          requestBodyValues: {},
          statusCode: 404,
        }),
      }),
      new RequestFailed({ cause: new Error("Overloaded") }),
      new RequestFailed({
        cause: '{"type":"error","error":{"type":"too_many_requests"}}',
      }),
      new RequestFailed({ cause: new DOMException("Cancelled", "AbortError") }),
    ];
    for (const failure of failures) expect(isRetryable(failure)).toBe(false);
  });

  test("records stream stalls as explicit transient API errors", () => {
    const failure = new StreamStalled({ stallMs: 60_000 });

    expect(isModelFailure(failure)).toBe(true);
    expect(isRetryable(failure)).toBe(true);
    expect(toMessageError(failure, "test")).toEqual({
      name: "APIError",
      data: {
        message: "Model stream produced no events for 60000 ms",
        isRetryable: true,
      },
    });
  });

  test("retains typed connection resets without matching error messages", () => {
    const reset = new RequestFailed({
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    expect(isRetryable(reset)).toBe(true);
    expect(toMessageError(reset, "test")).toEqual({
      name: "APIError",
      data: {
        message: "read ECONNRESET",
        isRetryable: true,
        metadata: { code: "ECONNRESET" },
      },
    });
    expect(
      isRetryable(new RequestFailed({ cause: new Error("ECONNRESET") })),
    ).toBe(false);
  });

  test("retains auth identity and never retries model setup failures", () => {
    const cause = new LoadAPIKeyError({ message: "API key is missing" });
    const init = new ProviderInit({ providerID: "actual", cause });

    expect(isRetryable(init)).toBe(false);
    expect(toMessageError(init, "selected")).toEqual({
      name: "ProviderAuthError",
      data: { providerID: "actual", message: cause.message },
    });
    expect(toMessageError(new RequestFailed({ cause }), "selected")).toEqual({
      name: "ProviderAuthError",
      data: { providerID: "selected", message: cause.message },
    });
  });

  test("records lookup failures with concrete model identifiers", () => {
    const missing = new ModelNotFound({
      providerID: "test",
      modelID: "absent",
      cause: undefined,
    });
    const variant = new VariantNotFound({
      providerID: "test",
      modelID: "model",
      variant: "absent",
    });

    for (const failure of [missing, variant]) {
      expect(isModelFailure(failure)).toBe(true);
      expect(isRetryable(failure)).toBe(false);
    }
    expect(toMessageError(missing, "test").data).toEqual({
      message: "Model test/absent was not found",
    });
    expect(toMessageError(variant, "test").data).toEqual({
      message: "Model test/model does not offer variant absent",
    });
  });

  test("does not classify storage errors, arbitrary defects, or forged tags", () => {
    expect(isModelFailure(new Error("Database failed"))).toBe(false);
    expect(isModelFailure(new TypeError("Programming defect"))).toBe(false);
    expect(isModelFailure({ _tag: "LLM.RequestFailed" })).toBe(false);
    expect(isModelFailure(null)).toBe(false);
  });
});
