// Purpose: Prepares an unnamed Home directory before registering it in the caller's transaction.

import * as path from "node:path";
import { Home } from "@openchart/server/home";
import { Transition } from "@openchart/server/lib/resource";
import { invalidRoot } from "@openchart/server/resources/workspace/store";
import { Effect, FileSystem, Schema } from "effect";

import { register } from "./register";

/**
 * Creates and registers an unnamed Home directory. Directory preparation runs
 * before the transaction; the directory remains after registration failure or forget.
 * @example yield* Transactor.run(workspaceResource.transitions.createLocal());
 */
export const createLocal = Transition.make({
  input: Schema.Void,
  resolve: () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const fs = yield* FileSystem.FileSystem;
      const directory = path.join(home.root, "workspaces");
      if ((yield* fs.realPath(directory)) !== directory)
        return yield* invalidRoot(
          "The workspace directory must not traverse a symbolic link.",
        );
      const root = yield* fs.makeTempDirectory({
        directory,
        prefix: "workspace-",
      });
      return yield* register.resolve({ root });
    }),
  apply: (tx, _input, root) => register.apply(tx, { root }, root),
});
