// Purpose: Verifies directory registration transitions and immutable internal writes.

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
  readFile,
  readdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "@openchart/server/db";
import { Home } from "@openchart/server/home";
import {
  ResourceStateInvalid,
  Transactor,
  Transition,
} from "@openchart/server/lib/resource";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, expect, test } from "vitest";

import { ensureDefault } from "@openchart/server/resources/workspace/transitions/ensure-default";
import { workspaceResource } from "./resource";
import { workspaceStore } from "./store";
import { MAX_PAGE_SIZE } from "@openchart/server/lib/resource/pagination";

function makeRegistryRuntime(home: string) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      Home.layer(home).pipe(Layer.provideMerge(NodeFileSystem.layer)),
      Database.layer(":memory:", () => Effect.void),
    ),
  );
}

let directory: string;
let runtime: ReturnType<typeof makeRegistryRuntime>;

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "openchart-workspace-resource-")),
  );
  runtime = makeRegistryRuntime(path.join(directory, "home"));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
});

const register = (root: string) =>
  runtime.runPromise(
    Transactor.run(workspaceResource.transitions.register({ root })),
  );
const list = () =>
  runtime.runPromise(Transactor.run(workspaceResource.transitions.listAll()));
const getDefault = () =>
  runtime.runPromise(
    Transactor.run(workspaceResource.transitions.getDefault()),
  );

test("getDefault only reads registration and finds the default beyond the first page", async () => {
  await expect(getDefault()).rejects.toThrow(
    "Default workspace registration is missing",
  );
  expect(await list()).toEqual([]);
  await expect(
    access(path.join(directory, "home", "workspaces", "default")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  for (let index = 0; index < MAX_PAGE_SIZE; index++) {
    const root = path.join(directory, `workspace-${index}`);
    await mkdir(root);
    await register(root);
  }
  const workspace = await runtime.runPromise(
    Transactor.run(Transition.bindInput(ensureDefault, undefined)),
  );
  expect(await getDefault()).toBe(workspace.id);
  expect(await list()).toHaveLength(MAX_PAGE_SIZE + 1);
});

test("canonicalizes an existing directory and rejects duplicate aliases and overlapping roots atomically", async () => {
  const root = path.join(directory, "studies");
  const child = path.join(root, "child");
  const sibling = `${root}-other`;
  await mkdir(child, { recursive: true });
  await mkdir(sibling);
  await symlink(root, path.join(directory, "alias"));
  const results = await Promise.allSettled([register(root), register(child)]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const [registered] = await list();
  expect(registered).toBeDefined();
  await expect(register(path.join(directory, "alias"))).rejects.toThrow();
  await expect(register(path.join(registered!.root, "."))).rejects.toThrow();
  await expect(register(directory)).rejects.toThrow();
  expect((await register(sibling)).root).toBe(sibling);
});

test("register requires an existing absolute directory and resolves before opening a transaction", async () => {
  const file = path.join(directory, "script.tea");
  await writeFile(file, "source");
  for (const root of ["relative", path.join(directory, "missing"), file]) {
    const failure = await runtime.runPromise(
      Effect.flip(
        Transactor.run(workspaceResource.transitions.register({ root })),
      ),
    );
    expect(failure).toBeInstanceOf(ResourceStateInvalid);
  }
  expect(await list()).toEqual([]);
});

test("ordinary patch and internal saves cannot change a registered root", async () => {
  const root = path.join(directory, "one");
  const other = path.join(directory, "two");
  await mkdir(root);
  await mkdir(other);
  const registration = await register(root);
  const patch = workspaceResource.transitions.patch({
    id: registration.id,
    expectedRevision: registration.revision,
    operations: [{ op: "replace", path: "/root", value: other }],
  });
  expect(
    await runtime.runPromise(Effect.flip(Transactor.run(patch))),
  ).toBeInstanceOf(ResourceStateInvalid);
  const internal = Transition.from((tx) =>
    workspaceStore.save(tx, registration.id, {
      body: { root: other },
      revision: 2,
    }),
  );
  expect(
    await runtime.runPromise(Effect.flip(Transactor.run(internal))),
  ).toBeInstanceOf(ResourceStateInvalid);
  expect(await list()).toEqual([registration]);
});

test("default initialization is idempotent, survives missing files, and prevents forgetting its registration", async () => {
  const [first, second] = await Promise.all([
    runtime.runPromise(
      Transactor.run(Transition.bindInput(ensureDefault, undefined)),
    ),
    runtime.runPromise(
      Transactor.run(Transition.bindInput(ensureDefault, undefined)),
    ),
  ]);
  expect(second).toEqual(first);
  await rm(first.root, { recursive: true });
  expect(await getDefault()).toBe(first.id);
  await expect(access(first.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await runtime.runPromise(
      Effect.flip(
        Transactor.run(workspaceResource.transitions.forget({ id: first.id })),
      ),
    ),
  ).toBeInstanceOf(ResourceStateInvalid);
  expect(
    await runtime.runPromise(
      Transactor.run(Transition.bindInput(ensureDefault, undefined)),
    ),
  ).toEqual(first);
  expect(await list()).toEqual([first]);
});

test("forget preserves files and re-registering the directory allocates a new identity", async () => {
  const root = path.join(directory, "owned");
  await mkdir(root);
  const file = path.join(root, "main.tea");
  await writeFile(file, "source");
  const first = await register(root);
  await runtime.runPromise(
    Transactor.run(workspaceResource.transitions.forget({ id: first.id })),
  );
  expect(await readFile(file, "utf8")).toBe("source");
  expect((await register(root)).id).not.toBe(first.id);
});

test("createLocal joins the caller's transaction while directory preparation survives rollback", async () => {
  const initial = await runtime.runPromise(
    Transactor.run(Transition.bindInput(ensureDefault, undefined)),
  );
  const creation = workspaceResource.transitions.createLocal();
  const failure = await runtime.runPromise(
    Effect.flip(
      Transactor.run(
        Transition.make({
          resolve: creation.resolve,
          apply: (tx, root) =>
            Effect.gen(function* () {
              yield* creation.apply(tx, root);
              return yield* Effect.fail("abort registration");
            }),
        }),
      ),
    ),
  );
  expect(failure).toBe("abort registration");
  expect(await list()).toEqual([initial]);
  const directories = await readdir(path.join(directory, "home", "workspaces"));
  expect(directories).toHaveLength(2);
  expect(directories.some((name) => name.startsWith("workspace-"))).toBe(true);
});
