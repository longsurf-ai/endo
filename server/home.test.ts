// Purpose: Pin home creation and canonical identity without using a real profile.

import { realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { Home } from "./home";
import { temporaryHome } from "./home.test-utils";

test("creates nested homes and resolves aliases to the same profile", async () => {
  const directory = temporaryHome();
  const root = join(directory, "nested", "profile");
  const read = (value: string) =>
    Effect.runPromise(
      Home.pipe(
        Effect.provide(
          Home.layer(value).pipe(Layer.provide(NodeFileSystem.layer)),
        ),
      ),
    );
  const home = await read(root);
  expect(home.root).toBe(await realpath(root));
  const alias = join(directory, "alias");
  await symlink(root, alias, "junction");
  expect(await read(alias)).toEqual(home);
});
