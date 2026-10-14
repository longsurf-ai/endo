// Purpose: Forgets a directory registration while protecting the Home default and preserving files.

import * as path from "node:path";
import { Home } from "@openchart/server/home";
import { Transition } from "@openchart/server/lib/resource";
import {
  loadExisting,
  toEntity,
} from "@openchart/server/lib/resource/entity-operations";
import {
  WorkspaceEntity,
  WorkspaceId,
} from "@openchart/server/resources/workspace/entity";
import {
  invalidRoot,
  workspaceStore,
} from "@openchart/server/resources/workspace/store";
import { Effect, Schema } from "effect";

/**
 * Removes only the registration, never its directory. The default registration
 * cannot be forgotten; existence and protection are checked in the caller's Tx.
 * @example defineResource({name, entity, store, readOnly: true, transitions: {forget}});
 */
export const forget = Transition.make({
  input: Schema.Struct({ id: WorkspaceId }),
  resolve: () =>
    Effect.map(Home, (home) => path.join(home.root, "workspaces", "default")),
  apply: (tx, { id }, defaultRoot) =>
    Effect.gen(function* () {
      const row = yield* loadExisting(workspaceStore, "workspace", tx, id);
      const workspace = yield* toEntity("workspace", WorkspaceEntity, row);
      if (workspace.root === defaultRoot)
        return yield* invalidRoot("The default workspace cannot be forgotten.");
      yield* workspaceStore.remove(tx, id);
    }),
});
