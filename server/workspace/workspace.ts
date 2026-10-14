// Purpose: Project persisted workspace registrations into scoped directory instances.
import {
  Context,
  Effect,
  Layer,
  Schedule,
  Schema,
  ScopedCache,
  Semaphore,
  Stream,
} from "effect";
import { Database } from "@openchart/server/db";
import { ResourceChanged } from "@openchart/server/lib/resource/events";
import { Events } from "@openchart/server/events";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { Transactor, Transition } from "@openchart/server/lib/resource";
import { ensureDefault } from "@openchart/server/resources/workspace/transitions/ensure-default";
import type { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import {
  WorkspaceClosed,
  WorkspaceReadFailed,
  WorkspaceUnknown,
} from "./errors";
import { makeWorkspace, type Workspace } from "./instance";
import type { WorkspaceInterest } from "./contract";

/** One registry per backend; persisted Resource rows remain authoritative. */
export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * Gets the shared instance for a registered workspace.
     *
     * - Registration: checks the database on every call, including cache hits.
     * - Reuse: creates the instance on first use; later calls reuse it by ID.
     *   Opening alone does not scan files or start filesystem watchers.
     * - Lifetime: Workspaces owns the instance and releases it when its
     *   registration is removed or the service scope closes.
     * - Failures: an unregistered ID fails with {@link WorkspaceUnknown};
     *   a registration lookup failure fails with {@link WorkspaceReadFailed}.
     *
     * @example
     * ```ts
     * const workspaces = yield* Workspaces;
     * const workspace = yield* workspaces.open(workspaceId);
     * const root = yield* workspace.listDirectory("");
     * ```
     */
    readonly open: (
      id: WorkspaceId,
    ) => Effect.Effect<Workspace, WorkspaceUnknown | WorkspaceReadFailed>;
    /**
     * Watches a fixed batch of file and directory interests across workspaces.
     *
     * - Notifications: emits the original interest on subscription and on
     *   invalidation, so the consumer can re-read the corresponding data.
     *   File interests share their parent directory's notifications.
     * - Lifetime: stopping the stream releases this consumer's observations.
     *   Workspace owns watcher sharing and cleanup.
     * - Removed workspaces: unknown or closed workspaces end only their own
     *   interests; the remaining workspaces continue to emit.
     * - Failures: other read failures fail the entire stream.
     *
     * @example
     * ```ts
     * workspaces.watch([
     *   { workspaceId, target: { kind: "directory", path: "" } },
     *   { workspaceId, target: { kind: "file", path: filePath } },
     * ]).pipe(
     *   Stream.runForEach((interest) => refresh(interest)),
     * );
     * ```
     */
    readonly watch: (
      interests: readonly WorkspaceInterest[],
    ) => Stream.Stream<WorkspaceInterest, WorkspaceReadFailed>;
  }
>()("@openchart/server/Workspaces") {}

/**
 * Boots the default registration; directory instances and observations are lazy.
 * Resource notifications reconcile the scoped cache; every file admission also
 * checks the database so deletion is effective before event delivery catches up.
 * @example const application = WorkspacesLayer.pipe(Layer.provideMerge(database));
 */
export const WorkspacesLayer = Layer.effect(
  Workspaces,
  Effect.gen(function* () {
    const { db } = yield* Database.Service;
    const events = yield* Events.Service;
    const defaultWorkspace = yield* Transactor.run(
      Transition.bindInput(ensureDefault, undefined),
    );
    const mutex = yield* Semaphore.make(1);
    const load = (id: WorkspaceId) =>
      db
        .transaction((tx) =>
          workspaceResource.transitions.get(id).apply(tx, undefined),
        )
        .pipe(
          Effect.catchTag("Resource.NotFound", () =>
            Effect.fail(new WorkspaceUnknown({ workspaceId: id })),
          ),
          Effect.mapError((cause) =>
            cause instanceof WorkspaceUnknown
              ? cause
              : new WorkspaceReadFailed({ workspaceId: id, path: "", cause }),
          ),
        );
    const cache = yield* ScopedCache.make({
      capacity: Infinity,
      lookup: (id: WorkspaceId) =>
        Effect.gen(function* () {
          const record = yield* load(id);
          const assertRegistered = load(id).pipe(
            Effect.asVoid,
            Effect.catchTag("WorkspaceUnknown", () =>
              Effect.fail(new WorkspaceClosed({ workspaceId: id })),
            ),
          );
          return yield* makeWorkspace(
            id,
            record.root,
            id === defaultWorkspace.id,
            assertRegistered,
          );
        }),
    });
    const reconcile = mutex.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* db.transaction((tx) =>
          workspaceResource.transitions.listAll().apply(tx, undefined),
        );
        const ids = new Set(records.map((record) => record.id));
        for (const id of yield* ScopedCache.keys(cache)) {
          if (!ids.has(id)) yield* ScopedCache.invalidate(cache, id);
        }
      }),
    );
    const changes = yield* events.allBounded(256);
    yield* reconcile;
    // Re-subscribe before resnapshotting after an overflow; no registration is lost.
    const observeRegistrations = (source: typeof changes) =>
      source.pipe(
        Stream.filter(Schema.is(ResourceChanged)),
        Stream.filter((event) => event.data.resource === "workspace"),
        Stream.runForEach(() => reconcile),
      );
    yield* observeRegistrations(changes).pipe(
      Effect.catch(() =>
        Effect.scoped(
          Effect.gen(function* () {
            const source = yield* events.allBounded(256);
            yield* reconcile;
            yield* observeRegistrations(source);
          }),
        ).pipe(Effect.retry(Schedule.spaced("250 millis"))),
      ),
      Effect.forkScoped,
    );
    const open = (id: WorkspaceId) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* load(id);
          return yield* ScopedCache.get(cache, id);
        }),
      );
    return Workspaces.of({
      open,
      watch: (interests) =>
        Stream.mergeAll(
          interests.map((interest) =>
            Stream.unwrap(
              open(interest.workspaceId).pipe(
                Effect.map((workspace) =>
                  workspace
                    .watch(interest.target)
                    .pipe(Stream.map(() => interest)),
                ),
              ),
            ).pipe(
              Stream.catchTag(
                ["WorkspaceUnknown", "WorkspaceClosed"],
                () => Stream.empty,
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
    });
  }),
);
