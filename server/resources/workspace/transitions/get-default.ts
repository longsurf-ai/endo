// Purpose: Reads the Home default registration without preparing directories or creating rows.

import * as path from "node:path";
import { Home } from "@openchart/server/home";
import { Transition } from "@openchart/server/lib/resource";
import { toEntity } from "@openchart/server/lib/resource/entity-operations";
import {
  listPage,
  MAX_PAGE_SIZE,
  type ListPosition,
} from "@openchart/server/lib/resource/pagination";
import { WorkspaceEntity } from "@openchart/server/resources/workspace/entity";
import { workspaceStore } from "@openchart/server/resources/workspace/store";
import { Effect, Schema } from "effect";

/**
 * Reads the default ID from the registry in the caller's transaction. Startup
 * must run ensureDefault first; a missing registration defects without writing.
 * Database failures propagate. Directory availability does not change the ID.
 * @example yield* Transactor.run(workspaceResource.transitions.getDefault());
 */
export const getDefault = Transition.make({
  kind: "query",
  input: Schema.Void,
  resolve: () =>
    Effect.map(Home, (home) => path.join(home.root, "workspaces", "default")),
  apply: (tx, _input, root) =>
    Effect.gen(function* () {
      let cursor: ListPosition | undefined;
      do {
        const page = listPage(
          yield* workspaceStore.list(
            tx,
            {},
            { limit: MAX_PAGE_SIZE + 1, cursor },
          ),
          MAX_PAGE_SIZE,
        );
        for (const row of page.items) {
          const workspace = yield* toEntity("workspace", WorkspaceEntity, row);
          if (workspace.root === root) return workspace.id;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return yield* Effect.die("Default workspace registration is missing");
    }),
});
