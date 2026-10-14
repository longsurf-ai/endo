// Purpose: Locks serialized message errors without runtime error dependencies.

import { Schema, Result } from "effect";

import { describe, expect, it } from "vitest";
import * as Message from "./message";

describe("message schemas", () => {
  it("preserves optional workspace selections and rejects null or empty IDs", () => {
    const user = {
      id: "msg_user",
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "analyst",
      model: { providerID: "openai", modelID: "test" },
    };
    expect(Schema.decodeUnknownSync(Message.User)(user)).toEqual(user);
    expect(
      Schema.decodeUnknownSync(Message.User)({
        ...user,
        workspaceId: "wsp_selected",
      }),
    ).toEqual({ ...user, workspaceId: "wsp_selected" });
    for (const workspaceId of [null, ""]) {
      expect(() =>
        Schema.decodeUnknownSync(Message.User)({ ...user, workspaceId }),
      ).toThrow();
    }
  });
  it("keeps prompt reconciliation and rejects retired Dig In intents", () => {
    const operation = { sessionIntentId: "intent_branch", kind: "prompt" };
    expect(Schema.decodeUnknownSync(Message.OperationEcho)(operation)).toEqual(
      operation,
    );
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(Message.OperationEcho)({
          ...operation,
          kind: "dig_in",
        }),
      ),
    ).toBe(false);
  });

  it("preserves serialized error names and data without runtime error classes", () => {
    const errors = [
      {
        name: "ProviderAuthError",
        data: { providerID: "openai", message: "Missing key" },
      },
      { name: "UnknownError", data: { message: "Unknown" } },
      { name: "MessageOutputLengthError", data: {} },
      { name: "MessageAbortedError", data: { message: "Cancelled" } },
      {
        name: "APIError",
        data: {
          message: "Retry",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "1" },
          responseBody: "limit",
          metadata: { provider: "openai" },
        },
      },
    ];
    for (const error of errors)
      expect(
        Schema.decodeUnknownSync(Message.Assistant.fields.error)(error),
      ).toEqual(error);
  });
});
