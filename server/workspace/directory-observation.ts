// Purpose: Share shallow directory observations and release them with their last consumer.
import path from "node:path";
import type { Stats } from "node:fs";
import { watch } from "chokidar";
import {
  Cause,
  Effect,
  Queue,
  RcMap,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect";
import type { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import type { DirectoryPath } from "./contract";
import { WorkspaceReadFailed } from "./errors";

/**
 * Acquires one non-recursive watcher per used directory. RcMap owns sharing and
 * final release. Retries publish invalidations so readers expose missing/error
 * states; readiness publishes again to close the initial read/watch race.
 * @example const changes = yield* RcMap.get(observations, directory);
 */
export const makeDirectoryObservations = Effect.fn("Workspace.observations")(
  function* <E>(
    workspaceId: WorkspaceId,
    root: string,
    verify: (directory: DirectoryPath) => Effect.Effect<Stats, E>,
  ) {
    return yield* RcMap.make({
      idleTimeToLive: "250 millis",
      lookup: (directory: DirectoryPath) =>
        Effect.gen(function* () {
          const revision = yield* SubscriptionRef.make(0);
          const invalidate = SubscriptionRef.update(
            revision,
            (value) => value + 1,
          );
          const attempt = Effect.scoped(
            Effect.gen(function* () {
              const identity = yield* verify(directory);
              const filename = path.join(root, directory);
              const changes = Stream.callback<void, WorkspaceReadFailed>(
                (queue) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      const signal = () => {
                        Queue.offerUnsafe(queue, undefined);
                      };
                      return watch(filename, {
                        depth: 0,
                        ignoreInitial: true,
                        followSymlinks: false,
                        ignored: (candidate) =>
                          path
                            .relative(root, candidate)
                            .split(path.sep)
                            .some((part) => part.startsWith(".")),
                      })
                        .on("ready", signal)
                        .on("all", signal)
                        .on("error", (cause) =>
                          Queue.failCauseUnsafe(
                            queue,
                            Cause.fail(
                              new WorkspaceReadFailed({
                                workspaceId,
                                path: directory,
                                cause,
                              }),
                            ),
                          ),
                        );
                    }),
                    (watcher) => Effect.promise(() => watcher.close()),
                  ),
                { bufferSize: 1, strategy: "sliding" },
              );
              const checkIdentity = Effect.gen(function* () {
                const current = yield* verify(directory);
                if (
                  current.dev !== identity.dev ||
                  current.ino !== identity.ino
                )
                  return yield* new WorkspaceReadFailed({
                    workspaceId,
                    path: directory,
                    cause: new Error("Directory replaced"),
                  });
              }).pipe(Effect.repeat(Schedule.spaced("5 seconds")));
              yield* Effect.raceFirst(
                changes.pipe(Stream.runForEach(() => invalidate)),
                checkIdentity,
              );
            }),
          );
          yield* attempt.pipe(
            Effect.tapError(() => invalidate),
            Effect.retry(Schedule.spaced("5 seconds")),
            Effect.forkScoped,
          );
          return SubscriptionRef.changes(revision);
        }),
    });
  },
);
