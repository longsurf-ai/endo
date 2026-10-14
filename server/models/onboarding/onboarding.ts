// Purpose: Owns provider installation, automatic manifest reconciliation, and native login jobs.
import { Effect, Fiber, Queue, Scope, Semaphore } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ProviderDiscoveryResult } from "@openchart/models/model-provider";
import {
  MODEL_PROVIDER_IDS,
  type NativeProviderID,
} from "@openchart/models/model-tiers";
import type { ModelError } from "@openchart/server/models/errors";
import { SetupFailed } from "./errors";
import {
  executeSetupCommand,
  makeSetupJob,
  runSetupJob,
  type SetupJob,
} from "./setup-job";
import type { SetupAction, SetupState } from "./setup-state";
import { installationTask, type Installations } from "./installation";

/** Internal setup contract; the creating scope owns jobs and awaits their cleanup. */
export interface ProviderSetup {
  /** Reads the retained job state without starting setup.
   * @example const state = yield* setup.state(providerID);
   */
  readonly state: (providerID: NativeProviderID) => Effect.Effect<SetupState>;

  /** Starts one installation or login; rejects duplicate or stale actions.
   * Execution failures are retained in job state; discovery failures propagate.
   * @example const job = yield* setup.start(providerID, "install");
   */
  readonly start: (
    providerID: NativeProviderID,
    action: SetupAction,
  ) => Effect.Effect<
    Exclude<SetupState, { status: "idle" }>,
    SetupFailed | ModelError
  >;

  /** Sends a line to the active login job; rejects stale IDs and installation jobs.
   * @example yield* setup.write(providerID, jobID, code);
   */
  readonly write: (
    providerID: NativeProviderID,
    id: string,
    text: string,
  ) => Effect.Effect<void, SetupFailed>;

  /** Cancels an active job, awaits cleanup and refreshes discovery.
   * Rejects stale IDs and propagates refresh failures.
   * @example yield* setup.cancel(providerID, jobID);
   */
  readonly cancel: (
    providerID: NativeProviderID,
    id: string,
  ) => Effect.Effect<void, SetupFailed | ModelError>;
}

/**
 * Installs missing app-pinned runtimes in the background when startup installation is enabled.
 * Jobs and downloads belong to this scope. No caller can supply executable paths or download URLs.
 * @example const setup = yield* makeProviderSetup(discover, refresh, installations, changed, true);
 */
export const makeProviderSetup = Effect.fn("Models.onboarding")(function* (
  discover: (
    id: NativeProviderID,
  ) => Effect.Effect<ProviderDiscoveryResult, ModelError>,
  refresh: (id: NativeProviderID) => Effect.Effect<void, ModelError>,
  installations: Installations,
  changed: Effect.Effect<void>,
  installOnStartup = false,
): Effect.fn.Return<
  ProviderSetup,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const scope = yield* Effect.scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gate = Semaphore.makeUnsafe(1);
  const jobs = new Map<NativeProviderID, SetupJob>();
  const state = (providerID: NativeProviderID): Effect.Effect<SetupState> =>
    Effect.sync(() => jobs.get(providerID)?.state ?? { status: "idle" });
  const active = Effect.fn("Models.setup.active")(function* (
    providerID: NativeProviderID,
    id: string,
  ) {
    const job = jobs.get(providerID);
    if (!job || job.state.id !== id || job.state.status !== "running")
      return yield* new SetupFailed({
        message: "This setup operation has finished. Check the provider again.",
      });
    return job;
  });
  const start = Effect.fn("Models.setup.start")(function* (
    providerID: NativeProviderID,
    action: SetupAction,
  ) {
    if (jobs.get(providerID)?.state.status === "running")
      return yield* new SetupFailed({
        message: "Setup is already running for this provider.",
      });
    const job = yield* makeSetupJob(action);
    let operation: Effect.Effect<void, unknown, Scope.Scope>;
    if (action === "install") {
      if (yield* installationTask(() => installations.installed(providerID)))
        return yield* new SetupFailed({
          message: "This provider is already installed. Check again.",
        });
      operation = installationTask((signal) =>
        installations.install(providerID, signal, (output) => {
          job.state = { ...job.state, output };
        }),
      );
    } else {
      const result = yield* discover(providerID);
      if (result.status !== "authentication_required")
        return yield* new SetupFailed({
          message: "Sign-in is no longer required. Check the provider again.",
        });
      operation = executeSetupCommand(job, result.login, spawner);
    }
    jobs.set(providerID, job);
    job.fiber = yield* runSetupJob(
      job,
      operation,
      () => refresh(providerID),
      changed,
    ).pipe(Effect.forkIn(scope, { startImmediately: true }));
    yield* changed;
    return job.state;
  }, gate.withPermit);
  const write = Effect.fn("Models.setup.write")(function* (
    providerID: NativeProviderID,
    id: string,
    text: string,
  ): Effect.fn.Return<void, SetupFailed> {
    const job = yield* active(providerID, id);
    if (job.state.action !== "login")
      return yield* new SetupFailed({ message: "Only sign-in accepts input." });
    yield* Queue.offer(job.input, new TextEncoder().encode(text + "\n"));
  });
  const cancel = Effect.fn("Models.setup.cancel")(function* (
    providerID: NativeProviderID,
    id: string,
  ) {
    const job = yield* active(providerID, id);
    if (job.fiber) yield* Fiber.interrupt(job.fiber);
    yield* refresh(providerID);
    yield* changed;
  });
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => jobs.clear()),
  );
  if (installOnStartup)
    yield* Effect.forEach(
      MODEL_PROVIDER_IDS,
      (providerID) =>
        installationTask(() => installations.installed(providerID)).pipe(
          Effect.flatMap((installed) =>
            installed ? Effect.void : start(providerID, "install"),
          ),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (jobs.has(providerID)) return;
              const job = yield* makeSetupJob("install");
              job.state = {
                ...job.state,
                status: "failed",
                output: error.message,
              };
              yield* Queue.shutdown(job.input);
              jobs.set(providerID, job);
              yield* changed;
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.forkScoped);
  return { state, start, write, cancel };
});
