// Purpose: Enforces registration uniqueness, overlap, and immutable roots within SQLite transactions.

import * as path from "node:path";
import { ResourceStateInvalid } from "@openchart/server/lib/resource/errors";
import { listWindowSql } from "@openchart/server/lib/resource/pagination-sql";
import type { Store, StoreBody } from "@openchart/server/lib/resource/store";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { WorkspaceEntity } from "./entity";
import { workspaceTable } from "./schema";

function row({ root, ...envelope }: typeof workspaceTable.$inferSelect) {
  return { ...envelope, body: { root } };
}

function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Caller-correctable directory rules use the existing Resource error contract.
 * @example return yield* invalidRoot("Workspace root cannot change.");
 */
export function invalidRoot(reason: string) {
  return new ResourceStateInvalid({
    resource: "workspace",
    reason,
    issues: [{ code: "workspace.root", path: "/root", message: reason }],
  });
}

/** Internal persistence seam; callers use workspaceResource transitions for external resolution. */
export const workspaceStore: Store<StoreBody<typeof WorkspaceEntity>> = {
  load: (tx, id) =>
    tx
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, id))
      .get()
      .pipe(Effect.map((value) => value && row(value))),
  list: (tx, _filter, window) => {
    const page = listWindowSql(workspaceTable, window);
    return tx
      .select()
      .from(workspaceTable)
      .where(page.where)
      .orderBy(...page.orderBy)
      .limit(page.limit)
      .pipe(Effect.map((values) => values.map(row)));
  },
  insert: (tx, input) =>
    Effect.gen(function* () {
      const roots = yield* tx
        .select({ root: workspaceTable.root })
        .from(workspaceTable);
      if (
        roots.some(
          ({ root }) =>
            contains(root, input.body.root) || contains(input.body.root, root),
        )
      ) {
        return yield* invalidRoot(
          "Workspace directories must not duplicate or overlap an existing registration.",
        );
      }
      const inserted = yield* tx
        .insert(workspaceTable)
        .values({
          id: input.id,
          revision: input.revision,
          root: input.body.root,
        })
        .returning()
        .get();
      if (!inserted)
        return yield* Effect.die("Workspace insert returned no row");
      return row(inserted);
    }),
  save: (tx, id, input) =>
    Effect.gen(function* () {
      const current = yield* tx
        .select()
        .from(workspaceTable)
        .where(eq(workspaceTable.id, id))
        .get();
      if (!current)
        return yield* Effect.die("Workspace disappeared during save");
      if (input.body.root !== current.root)
        return yield* invalidRoot("A registered workspace root cannot change.");
      const saved = yield* tx
        .update(workspaceTable)
        .set({ revision: input.revision })
        .where(eq(workspaceTable.id, id))
        .returning()
        .get();
      if (!saved) return yield* Effect.die("Workspace save returned no row");
      return row(saved);
    }),
  remove: (tx, id) =>
    tx
      .delete(workspaceTable)
      .where(eq(workspaceTable.id, id))
      .pipe(Effect.asVoid),
};
