// Purpose: Prepares the Home default directory and atomically reuses or creates its registration.

import * as path from "node:path";
import { Home } from "@openchart/server/home";
import { Transition } from "@openchart/server/lib/resource";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { invalidRoot } from "@openchart/server/resources/workspace/store";
import { Effect, FileSystem, Schema } from "effect";

import { register } from "./register";

/**
 * Prepares the default directory at startup and after removal, without following
 * symbolic links. The directory persists independently of the caller's Scope.
 * Fails with an invalid-root or filesystem error when preparation is unsafe or fails.
 * @example yield* prepareDefaultDirectory(root);
 */
export const prepareDefaultDirectory = Effect.fn(
  "Workspace.prepareDefaultDirectory",
)(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  let ancestor = root;
  while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
  if ((yield* fs.realPath(ancestor)) !== ancestor)
    return yield* invalidRoot(
      "The default workspace must not traverse a symbolic link.",
    );
  yield* fs.makeDirectory(root, { recursive: true });
});

/**
 * Ensures the default registration before requests start. Directory preparation
 * runs in resolve; lookup and insertion share apply's transaction. Preparation
 * is not rolled back. This startup transition is not exposed as a public mutation.
 * @example yield* Transactor.run(Transition.bindInput(ensureDefault, undefined));
 */
export const ensureDefault = Transition.make({
  input: Schema.Void,
  resolve: () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const root = path.join(home.root, "workspaces", "default");
      yield* prepareDefaultDirectory(root);
      const canonical = yield* register.resolve({ root });
      if (canonical !== root)
        return yield* invalidRoot(
          "The default workspace must not traverse a symbolic link.",
        );
      return canonical;
    }),
  apply: (tx, _input, root) =>
    Effect.gen(function* () {
      const all = yield* workspaceResource.transitions.listAll().apply(tx);
      const existing = all.find((workspace) => workspace.root === root);
      return existing ?? (yield* register.apply(tx, { root }, root));
    }),
});
