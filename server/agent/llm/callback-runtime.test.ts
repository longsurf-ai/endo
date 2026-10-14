// Purpose: Verifies callback cancellation, cleanup, and failure propagation without an SDK.

import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { createCallbackRuntime } from "./callback-runtime";

const cleanups: Array<() => Promise<void>> = [];

test("captures required services for callbacks invoked outside Effect", async () => {
  class RequestValue extends Context.Service<RequestValue, { value: string }>()(
    "RequestValue",
  ) {}
  const scope = Scope.makeUnsafe();
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const make = createCallbackRuntime<RequestValue>();
  expectTypeOf<Effect.Services<typeof make>>().toEqualTypeOf<
    RequestValue | Scope.Scope
  >();
  const runtime = await Effect.runPromise(
    make.pipe(
      Scope.provide(scope),
      Effect.provideService(RequestValue, { value: "request" }),
    ),
  );
  await expect(
    runtime.runPromise(
      Effect.map(RequestValue, (service) => service.value),
      new AbortController().signal,
    ),
  ).resolves.toBe("request");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const request = new AbortController();
  const scope = Scope.makeUnsafe();
  const callbackRuntime = await Effect.runPromise(
    createCallbackRuntime().pipe(Scope.provide(scope)),
  );
  const defect = Effect.runFork(Effect.exit(callbackRuntime.defect));
  const close = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  };
  cleanups.push(async () => {
    await close();
    await Effect.runPromise(Fiber.interrupt(defect));
  });
  return { request, callbackRuntime, defect, close };
}

test("resolves with the exact result without stopping the request", async () => {
  const f = await fixture();
  const result = { title: "Done", output: { type: "text", value: "Hello" } };

  await expect(
    f.callbackRuntime.runPromise(Effect.succeed(result), f.request.signal),
  ).resolves.toBe(result);
  expect(f.defect.pollUnsafe()).toBeUndefined();
});

test("rejects an expected error without stopping the request", async () => {
  const f = await fixture();
  const error = new Error("Tool arguments rejected");

  await expect(
    f.callbackRuntime.runPromise(Effect.fail(error), f.request.signal),
  ).rejects.toBe(error);
  expect(f.defect.pollUnsafe()).toBeUndefined();
});

test("reports a defect even when the SDK catches the rejection", async () => {
  const f = await fixture();
  const error = new Error("Tool crashed");
  const caught = vi.fn();

  await f.callbackRuntime
    .runPromise(Effect.die(error), f.request.signal)
    .catch(caught);

  expect(caught).toHaveBeenCalledExactlyOnceWith(error);
  const exit = await Effect.runPromise(
    Fiber.join(f.defect).pipe(Effect.timeout("2 seconds")),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.squash(exit.cause)).toBe(error);
  }
});

test("leaves callback interruption to the SDK without stopping the request", async () => {
  const f = await fixture();

  await expect(
    f.callbackRuntime.runPromise(Effect.interrupt, f.request.signal),
  ).rejects.toBeDefined();
  expect(f.defect.pollUnsafe()).toBeUndefined();
  await expect(
    f.callbackRuntime.runPromise(Effect.succeed("Continue"), f.request.signal),
  ).resolves.toBe("Continue");
});

test("reports only defects when cleanup also fails", async () => {
  const f = await fixture();
  const error = new Error("Tool failed");
  const defect = new Error("Cleanup crashed");
  const effect = Effect.fail(error).pipe(Effect.ensuring(Effect.die(defect)));

  await expect(
    f.callbackRuntime.runPromise(effect, f.request.signal),
  ).rejects.toBeDefined();

  const exit = await Effect.runPromise(
    Fiber.join(f.defect).pipe(Effect.timeout("2 seconds")),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasFails(exit.cause)).toBe(false);
    expect(Cause.hasInterrupts(exit.cause)).toBe(false);
    expect(Cause.squash(exit.cause)).toBe(defect);
  }
});

test.each(["already aborted", "aborted before resuming"])(
  "does not enter callback code when its signal is %s",
  async (timing) => {
    const f = await fixture();
    const invocation = new AbortController();
    const execute = vi.fn();
    if (timing === "already aborted") invocation.abort();

    const pending = f.callbackRuntime.runPromise(
      Effect.sync(execute),
      invocation.signal,
    );
    if (timing === "aborted before resuming") invocation.abort();

    await expect(pending).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    expect(f.defect.pollUnsafe()).toBeUndefined();
  },
);

test.each(["before invocation", "before callback resumes"])(
  "does not enter callback code when the request closes %s",
  async (timing) => {
    const f = await fixture();
    const execute = vi.fn();
    if (timing === "before invocation") await f.close();

    // A fresh SDK signal must not let work outlive the owning request Scope.
    const pending = f.callbackRuntime.runPromise(
      Effect.sync(execute),
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await f.close();
    await rejected;

    expect(execute).not.toHaveBeenCalled();
    expect(f.defect.pollUnsafe()).toBeUndefined();
  },
);

test.each(["invocation", "request", "scope"])(
  "%s cancellation waits for callback cleanup and preserves the request outcome",
  async (owner) => {
    const f = await fixture();
    const invocation = new AbortController();
    const signal =
      owner === "invocation" ? invocation.signal : f.request.signal;
    const started = Deferred.makeUnsafe<void>();
    const cleanupStarted = Deferred.makeUnsafe<void>();
    const releaseCleanup = Deferred.makeUnsafe<void>();
    const released = vi.fn();
    let promiseSettled = false;
    let scopeClosed = false;
    let settledBeforeCleanup = true;
    let closedBeforeCleanup = true;
    let closing: Promise<void> | undefined;
    const effect = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(
        Deferred.succeed(cleanupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCleanup)),
          Effect.andThen(Effect.sync(released)),
        ),
      ),
    );
    const rejected = expect(
      f.callbackRuntime.runPromise(effect, signal).finally(() => {
        promiseSettled = true;
      }),
    ).rejects.toBeDefined();

    try {
      await Effect.runPromise(
        Deferred.await(started).pipe(Effect.timeout("2 seconds")),
      );
      if (owner === "scope") {
        closing = f.close().then(() => {
          scopeClosed = true;
        });
      } else if (owner === "request") {
        f.request.abort();
      } else {
        invocation.abort();
      }
      await Effect.runPromise(
        Deferred.await(cleanupStarted).pipe(Effect.timeout("2 seconds")),
      );
      settledBeforeCleanup = promiseSettled;
      closedBeforeCleanup = scopeClosed;
    } finally {
      Deferred.doneUnsafe(releaseCleanup, Effect.void);
    }
    await rejected;
    await closing;

    expect(settledBeforeCleanup).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    if (owner === "scope") {
      expect(closedBeforeCleanup).toBe(false);
      expect(scopeClosed).toBe(true);
    }
    expect(f.defect.pollUnsafe()).toBeUndefined();
  },
);

test("request shutdown still reports a defect raised during cleanup", async () => {
  const f = await fixture();
  const started = Deferred.makeUnsafe<void>();
  const error = new Error("Cleanup crashed");
  const effect = Deferred.succeed(started, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(Effect.die(error)),
  );
  const caught = f.callbackRuntime
    .runPromise(effect, f.request.signal)
    .catch(() => {});
  await Effect.runPromise(
    Deferred.await(started).pipe(Effect.timeout("2 seconds")),
  );

  f.request.abort();
  await caught;

  const exit = await Effect.runPromise(
    Fiber.join(f.defect).pipe(Effect.timeout("2 seconds")),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.squash(exit.cause)).toBe(error);
  }
});
