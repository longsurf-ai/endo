// Purpose: Locks expected prompt failures apart from defects and interruption at the runner seam.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { AgentRun } from "@openchart/server/agent/run/run";
import { makeRuntime } from "@openchart/server/runtime";
import { ModelNotFound } from "@openchart/server/models/errors";
import { Models } from "@openchart/server/models";
import { Cause, Effect, Exit, Schema } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import * as engine from "./execute";
import { Prompt } from "./prompt";
import { Failed } from "./errors";

const run = Schema.decodeUnknownSync(AgentRun)({
  id: "agr_test",
  sessionID: "session-1",
  sessionIntentID: "intent-1",
  input: {
    agent: "analyst",
    model: { providerID: "codex", modelID: "tier1" },
    parts: [{ type: "text", text: "Hello" }],
  },
  status: "running",
  queuePosition: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
});

afterEach(() => vi.restoreAllMocks());

test("uses prompt dependencies from the execution context", async () => {
  const list = vi.fn(() => Effect.succeed([]));
  vi.spyOn(engine, "execute").mockImplementation(() =>
    Models.Service.use((models) => models.list()).pipe(Effect.asVoid),
  );
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const prompt = yield* Prompt.Service;
        const models = yield* Models.Service;
        yield* prompt
          .execute(run)
          .pipe(Effect.provideService(Models.Service, { ...models, list }));
      }),
    );
    expect(list).toHaveBeenCalledExactlyOnceWith();
  } finally {
    await runtime.dispose();
  }
});

test.each(["expected", "defect", "interruption"] as const)(
  "preserves the %s prompt outcome at the service boundary",
  async (kind) => {
    const cause = new ModelNotFound({
      providerID: "openai",
      modelID: "test",
      cause: new Error("Missing model"),
    });
    const execute = vi.spyOn(engine, "execute").mockImplementation(() => {
      if (kind === "expected") return Effect.fail(cause);
      if (kind === "defect") return Effect.die(cause);
      return Effect.interrupt;
    });
    const runtime = makeRuntime({
      home: temporaryHome(),
      databasePath: ":memory:",
    });
    try {
      const exit = await runtime.runPromise(
        Prompt.Service.use((prompt) => prompt.execute(run)).pipe(Effect.exit),
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith(run);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      expect(Cause.hasDies(exit.cause)).toBe(kind === "defect");
      expect(Cause.hasInterrupts(exit.cause)).toBe(kind === "interruption");
      if (kind === "expected") {
        expect(exit.cause.reasons).toEqual([
          expect.objectContaining({
            _tag: "Fail",
            error: new Failed({ cause }),
          }),
        ]);
      }
    } finally {
      await runtime.dispose();
    }
  },
);
