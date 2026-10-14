// Purpose: Resolves an existing directory before registering it in one transaction.

import * as path from "node:path";
import { Transition } from "@openchart/server/lib/resource";
import { toEntity } from "@openchart/server/lib/resource/entity-operations";
import {
  WorkspaceEntity,
  WorkspaceId,
} from "@openchart/server/resources/workspace/entity";
import {
  invalidRoot,
  workspaceStore,
} from "@openchart/server/resources/workspace/store";
import { Effect, FileSystem, Schema } from "effect";

const canonicalRoot = Effect.fn("Workspace.canonicalRoot")(function* (
  root: string,
) {
  if (!path.isAbsolute(root))
    return yield* invalidRoot(
      "Workspace root must be an absolute directory path.",
    );
  const fs = yield* FileSystem.FileSystem;
  const canonical = yield* fs
    .realPath(root)
    .pipe(
      Effect.mapError(() =>
        invalidRoot("Workspace root must be an existing accessible directory."),
      ),
    );
  const info = yield* fs
    .stat(canonical)
    .pipe(
      Effect.mapError(() =>
        invalidRoot("Workspace root must be an existing accessible directory."),
      ),
    );
  if (info.type !== "Directory")
    return yield* invalidRoot("Workspace root must be a directory.");
  return canonical;
});

/**
 * Registers an existing canonical directory. The Store rejects duplicate and
 * overlapping roots inside the caller's transaction; files are never modified.
 * @example defineResource({name, entity, store, readOnly: true, transitions: {register}});
 */
export const register = Transition.make({
  input: Schema.Struct({ root: WorkspaceEntity.fields.root }),
  resolve: ({ root }) => canonicalRoot(root),
  apply: (tx, _input, root) =>
    Effect.gen(function* () {
      const row = yield* workspaceStore.insert(tx, {
        id: WorkspaceId.create(),
        revision: 1,
        body: { root },
      });
      return yield* toEntity("workspace", WorkspaceEntity, row);
    }),
});
