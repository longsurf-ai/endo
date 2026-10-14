// Purpose: Verifies Echo's input decoding, permission wait, and unchanged output.

import { InvalidArgumentsError } from "@openchart/server/agent/tool/errors";
import * as Tool from "@openchart/server/agent/tool/tool";
import { Deferred, Effect, Fiber, Result } from "effect";
import { expect, test, vi } from "vitest";
import { EchoTool } from "./echo";

const context: Tool.Context = {
  rootRunID: "agr_test",
  sessionID: "session",
  messageID: "message",
  callID: "call",
  agent: "analyst",
  messages: [],
  metadata: () => Effect.die("Echo must not report progress"),
  ask: () => Effect.void,
};

test.each(["hello", "", "  hello  ", "Grüße\nworld"])(
  "prefixes the unchanged string %j",
  async (input) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const echo = yield* Tool.init(yield* EchoTool);
        return yield* echo.execute({ text: input }, context);
      }),
    );
    expect(result).toEqual({
      title: "Echo",
      metadata: {},
      output: { type: "text", value: `echo ${input}` },
    });
  },
);

test("waits for permission before returning output and propagates rejection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const echo = yield* Tool.init(yield* EchoTool);
      const asked = yield* Deferred.make<void>();
      const approval = yield* Deferred.make<void, string>();
      const ask = vi.fn((request: Tool.PermissionRequest) =>
        Effect.gen(function* () {
          expect(request).toEqual({
            permission: "echo",
            patterns: ["approved text"],
            always: ["approved text"],
            metadata: { text: "approved text" },
          });
          yield* Deferred.succeed(asked, undefined);
          yield* Deferred.await(approval);
        }),
      );
      const execution = yield* echo
        .execute({ text: "approved text" }, { ...context, ask })
        .pipe(Effect.forkChild);
      yield* Deferred.await(asked);
      expect(execution.pollUnsafe()).toBeUndefined();
      yield* Deferred.fail(approval, "Permission rejected");
      const result = yield* Effect.result(Fiber.join(execution));
      expect(result).toEqual(Result.fail("Permission rejected"));
      expect(ask).toHaveBeenCalledOnce();
    }),
  );
});

test.each([
  null,
  undefined,
  "hello",
  42,
  true,
  {},
  { text: 42 },
  { text: null },
  ["hello"],
])("rejects input %j without a required string text field", async (input) => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const echo = yield* Tool.init(yield* EchoTool);
      return yield* Effect.result(echo.execute(input, context));
    }),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (!Result.isFailure(result)) throw new Error("Expected invalid input");
  expect(result.failure).toBeInstanceOf(InvalidArgumentsError);
  if (!(result.failure instanceof InvalidArgumentsError))
    throw new Error("Expected argument decoding failure");
  expect(result.failure.tool).toBe("echo");
});
