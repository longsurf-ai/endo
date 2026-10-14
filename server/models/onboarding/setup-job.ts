// Purpose: Executes one native setup job and records its bounded output and completion.
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { Cause, Effect, Exit, Fiber, Queue, Stream, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ProviderDiscoveryResult } from "@openchart/models/model-provider";
import type { ModelError } from "@openchart/server/models/errors";
import type { SetupAction, SetupState } from "./setup-state";
import { SetupFailed } from "./errors";

type SetupCommand = Extract<
  ProviderDiscoveryResult,
  { status: "authentication_required" }
>["login"];

/** One in-memory job; onboarding.ts owns registration, input, and fiber cancellation. */
export type SetupJob = {
  state: Exclude<SetupState, { status: "idle" }>;
  input: Queue.Queue<Uint8Array>;
  fiber?: Fiber.Fiber<void>;
};

/**
 * Creates an accepted job with bounded stdin; performs no process I/O.
 * The owner must run it with {@link runSetupJob}, which shuts down its input.
 * @example const job = yield* makeSetupJob("login");
 */
export const makeSetupJob = Effect.fn("Models.setup.makeSetupJob")(function* (
  action: SetupAction,
): Effect.fn.Return<SetupJob> {
  const input = yield* Queue.make<Uint8Array>({ capacity: 16 });
  return {
    state: { status: "running", id: randomUUID(), action, output: "" },
    input,
  };
});

/**
 * Runs one installation or native login and awaits resource cleanup.
 * A deadline bounds execution; failures become retained job state. Completion
 * refreshes models, while interruption leaves refresh to the cancelling caller.
 * @example yield* runSetupJob(job, operation, refresh, changed);
 */
export const runSetupJob = Effect.fn("Models.setup.runSetupJob")(function* (
  job: SetupJob,
  operation: Effect.Effect<void, unknown, Scope.Scope>,
  refresh: () => Effect.Effect<void, ModelError>,
  changed: Effect.Effect<void>,
) {
  yield* operation.pipe(
    Effect.timeout("15 minutes"),
    Effect.scoped,
    Effect.onExit((exit) => finishSetupJob(job, exit, refresh, changed)),
    // Failure is represented by retained state, never an unobserved fiber error.
    Effect.ignore,
  );
});

/** Runs trusted native login argv with inherited auth environment; nonzero exits fail with SetupFailed. @example yield* executeSetupCommand(job, command, spawner); */
export const executeSetupCommand = Effect.fn(
  "Models.setup.executeSetupCommand",
)(function* (
  job: SetupJob,
  command: SetupCommand,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const process = yield* spawner.spawn(
    ChildProcess.make(command.executable, command.args, {
      extendEnv: true,
      env: { DISABLE_AUTOUPDATER: "1" },
      // Native CLIs own their auth/config; discovery never starts this process.
      stdin: Stream.fromQueue(job.input),
      forceKillAfter: "2 seconds",
    }),
  );
  yield* process.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.sync(() => appendOutput(job, chunk))),
  );
  const code = yield* process.exitCode;
  if (code !== 0)
    return yield* new SetupFailed({
      message: `Sign-in exited with code ${code}.`,
    });
});

const finishSetupJob = Effect.fn("Models.setup.finishSetupJob")(function* (
  job: SetupJob,
  exit: Exit.Exit<void, unknown>,
  refresh: () => Effect.Effect<void, ModelError>,
  changed: Effect.Effect<void>,
) {
  yield* Queue.shutdown(job.input);
  const status = completionStatus(exit);
  // Expected installation/process failures remain visible in the bounded setup output.
  if (Exit.isFailure(exit) && status === "failed") {
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === "Some" && failure.value instanceof Error)
      appendOutput(job, "\n" + failure.value.message);
  }
  if (status === "failed")
    appendOutput(
      job,
      "\nSetup did not complete. Check the output and try again.",
    );
  // The next discovery read reports a refresh failure on the provider card.
  if (status !== "cancelled")
    yield* refresh().pipe(
      Effect.ignore({ log: "Warn", message: "Setup could not refresh models" }),
    );
  job.state = { ...job.state, status };
  if (status !== "cancelled") yield* changed;
});

function completionStatus(exit: Exit.Exit<void, unknown>) {
  if (Exit.isSuccess(exit)) return "succeeded";
  return Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed";
}

function appendOutput(job: SetupJob, text: string) {
  job.state = {
    ...job.state,
    output: stripVTControlCharacters(job.state.output + text).slice(-32_768),
  };
}
