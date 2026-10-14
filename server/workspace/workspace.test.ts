// Purpose: Exercise real directories, scoped watching, CAS, and the shared file RPC boundary.
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import { Deferred, Effect, FileSystem, Stream } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime } from "@openchart/server/runtime";
import { router } from "@openchart/server";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { Transactor } from "@openchart/server/lib/resource";
import { Workspaces } from "./workspace";

// The app ships no read-only originals; one example exercises the protection.
vi.mock("./builtins", () => ({
  builtinPaths: new Set(["templates/builtin/report.md"]),
}));
import { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import {
  DirectoryPath,
  RelativePath,
  RelPath,
  MediaPath,
  WORKSPACE_MEDIA_MAX_BYTES,
  type WorkspaceInterest,
} from "./contract";
import { Schema } from "effect";

let home: string;
let runtime: ReturnType<typeof makeRuntime>;
let client: ReturnType<typeof router.createCaller>;
const subscriptions: Array<{
  controller: AbortController;
  done: Promise<void>;
}> = [];
const observationErrors: unknown[] = [];
async function observe(
  workspaceId: Parameters<
    typeof client.workspace.watch
  >[0]["interests"][number]["workspaceId"],
  path = "",
) {
  const workspace = await runtime.runPromise(
    Effect.flatMap(Workspaces, (service) =>
      service.open(Schema.decodeUnknownSync(WorkspaceId)(workspaceId)),
    ),
  );
  const controller = new AbortController();
  const notices: number[] = [];
  const done = runtime
    .runPromise(
      workspace
        .watch({
          kind: "directory",
          path: Schema.decodeUnknownSync(DirectoryPath)(path),
        })
        .pipe(
          Stream.runForEach((revision) =>
            Effect.sync(() => {
              notices.push(revision);
            }),
          ),
        ),
      { signal: controller.signal },
    )
    .catch((error: unknown) => {
      if (!controller.signal.aborted) observationErrors.push(error);
    });
  subscriptions.push({ controller, done });
  await expect.poll(() => notices.some((revision) => revision > 0)).toBe(true);
  return notices;
}
const relative = Schema.decodeUnknownSync(RelPath);
beforeEach(async () => {
  // Native filesystem notifications are unavailable in some sandboxed runners.
  // Exercise Chokidar's real portable backend without changing production options.
  vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
  home = await realpath(temporaryHome());
  runtime = makeRuntime({
    home,
    databasePath: ":memory:",
    models: { fetchEnabled: false, userAgent: "workspace-test" },
  });
  await runtime.context();
  client = router.createCaller({ runtime });
});
afterEach(async () => {
  subscriptions.forEach(({ controller }) => controller.abort());
  await Promise.all(subscriptions.splice(0).map(({ done }) => done));
  await runtime.dispose();
  expect(observationErrors.splice(0)).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function ordinary() {
  const root = join(home, "studies");
  await mkdir(root);
  return await client.resources.workspace.register({ root });
}

test("registration and finite discovery install no watchers and read no file contents", async () => {
  const watch = vi.spyOn(FSWatcher.prototype, "add");
  const fs = await runtime.runPromise(FileSystem.FileSystem);
  const streams = vi.spyOn(fs, "stream");
  const record = await ordinary();
  await mkdir(join(record.root, "deep", "child"), { recursive: true });
  await writeFile(
    join(record.root, "deep", "child", "notes.md"),
    "large content",
  );
  expect(
    await client.workspace.listDirectory({ workspaceId: record.id, path: "" }),
  ).toEqual({ status: "ready", entries: [], directories: ["deep"] });
  expect(await client.workspace.listTree({ workspaceId: record.id })).toEqual({
    status: "ready",
    entries: [{ path: "deep/child/notes.md" }],
    directories: ["deep", "deep/child"],
  });
  expect(watch).not.toHaveBeenCalled();
  expect(streams).not.toHaveBeenCalled();
});

test("shallow observations are shared, ignore unopened descendants and release after the last consumer", async () => {
  const record = await ordinary();
  await mkdir(join(record.root, "unopened"));
  await writeFile(join(record.root, "main.tea"), "close");
  await writeFile(join(record.root, "unopened", "hidden.tea"), "close");
  const watch = vi.spyOn(FSWatcher.prototype, "add");
  const first = await observe(record.id);
  await observe(record.id);
  expect(watch).toHaveBeenCalledTimes(1);
  const watcher = watch.mock.results[0]!.value as FSWatcher;
  expect(watcher.getWatched()[join(record.root, "unopened")] ?? []).toEqual([]);
  const close = vi.spyOn(watcher, "close");
  const before = first.length;
  await writeFile(join(record.root, "unopened", "hidden.tea"), "open");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(first).toHaveLength(before);
  await writeFile(join(record.root, "main.tea"), "open");
  await expect.poll(() => first.length).toBeGreaterThan(before);
  subscriptions[0]!.controller.abort();
  await subscriptions[0]!.done;
  expect(close).not.toHaveBeenCalled();
  subscriptions[1]!.controller.abort();
  await subscriptions[1]!.done;
  await expect.poll(() => close.mock.calls.length).toBe(1);
});

test("reopening a directory reads edits made while it was unobserved", async () => {
  const record = await ordinary();
  await observe(record.id);
  const subscription = subscriptions.at(-1)!;
  subscription.controller.abort();
  await subscription.done;
  await writeFile(join(record.root, "new.md"), "new");
  await observe(record.id);
  expect(
    await client.workspace.listDirectory({ workspaceId: record.id, path: "" }),
  ).toMatchObject({ entries: [{ path: "new.md" }] });
});

test("batch observation ignores missing registrations and forgetting one keeps the others live", async () => {
  const first = await ordinary();
  const secondRoot = join(home, "other-studies");
  await mkdir(secondRoot);
  const second = await client.resources.workspace.register({
    root: secondRoot,
  });
  const workspaces = await runtime.runPromise(Workspaces);
  const notices: WorkspaceInterest[] = [];
  const controller = new AbortController();
  const watch = vi.spyOn(FSWatcher.prototype, "add");
  const done = runtime
    .runPromise(
      workspaces
        .watch([
          {
            workspaceId: Schema.decodeUnknownSync(WorkspaceId)("wsp_missing"),
            target: { kind: "directory", path: "" },
          },
          { workspaceId: first.id, target: { kind: "directory", path: "" } },
          { workspaceId: second.id, target: { kind: "directory", path: "" } },
        ])
        .pipe(
          Stream.runForEach((interest) =>
            Effect.sync(() => {
              notices.push(interest);
            }),
          ),
        ),
      { signal: controller.signal },
    )
    .catch((error: unknown) => {
      if (!controller.signal.aborted) observationErrors.push(error);
    });
  subscriptions.push({ controller, done });
  await expect
    .poll(() => notices.filter((item) => item.workspaceId === first.id).length)
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => notices.filter((item) => item.workspaceId === second.id).length)
    .toBeGreaterThanOrEqual(2);
  expect(watch).toHaveBeenCalledTimes(2);
  const firstIndex = watch.mock.calls.findIndex(
    ([root]) => root === first.root,
  );
  const close = vi.spyOn(
    watch.mock.results[firstIndex]!.value as FSWatcher,
    "close",
  );
  await client.resources.workspace.forget({ id: first.id });
  await expect.poll(() => close.mock.calls.length).toBe(1);
  notices.length = 0;
  await writeFile(join(secondRoot, "new.tea"), "close");
  await expect.poll(() => notices.length).toBeGreaterThan(0);
  expect(notices.every((item) => item.workspaceId === second.id)).toBe(true);
});

test("registration routes enforce directory rules and protect the default", async () => {
  await expect(
    client.resources.workspace.register({ root: "relative" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const record = await ordinary();
  await expect(
    client.resources.workspace.register({ root: record.root }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    client.resources.workspace.forget({
      id: await client.resources.workspace.getDefault(),
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await client.resources.workspace.get({ id: record.id })).toEqual(
    record,
  );
  await client.resources.workspace.forget({ id: record.id });
  await expect(
    client.resources.workspace.get({ id: record.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await realpath(record.root)).toBe(record.root);
});

test("boots one default and exposes disk-backed CAS with structured RPC conflicts", async () => {
  const workspaceId = await client.resources.workspace.getDefault();
  const root = join(home, "workspaces", "default");
  const entry = await client.workspace.write({
    workspaceId,
    path: "nested/main.tea",
    text: "close",
    expected: null,
  });
  expect(await readFile(join(root, "nested/main.tea"), "utf8")).toBe("close");
  const read = await client.workspace.read({ workspaceId, path: entry.path });
  expect(read).toEqual({
    entry,
    mediaType: "text/plain",
    readOnly: false,
    base64: Buffer.from("close").toString("base64"),
  });
  await writeFile(join(root, entry.path), "open");
  const conflict = await client.workspace
    .write({
      workspaceId,
      path: entry.path,
      text: "high",
      expected: entry.hash,
    })
    .catch((error) => error);
  expect(conflict.code).toBe("CONFLICT");
  expect(conflict.failure.details.entryStale).toMatchObject({
    workspaceId,
    path: entry.path,
    current: { path: entry.path },
  });
  expect(await readFile(join(root, entry.path), "utf8")).toBe("open");
  const current = await client.workspace.read({
    workspaceId,
    path: entry.path,
  });
  await client.workspace.rename({
    workspaceId,
    from: entry.path,
    to: "renamed.tea",
  });
  const renamed = await client.workspace.read({
    workspaceId,
    path: "renamed.tea",
  });
  expect(renamed.entry.hash).toBe(current.entry.hash);
  const removal = {
    workspaceId,
    path: renamed.entry.path,
    expected: renamed.entry.hash,
  };
  await client.workspace.remove(removal);
  await client.workspace.remove(removal);
});

test("rejects path escapes and symlink traversal at every file access", async () => {
  const workspace = await ordinary();
  const outside = join(home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.tea"), "outside");
  await symlink(outside, join(workspace.root, "linked"));
  for (const path of [
    "../outside/secret.tea",
    "/secret.tea",
    ".git/file.tea",
    "nested\\secret.tea",
  ]) {
    await expect(
      client.workspace.read({ workspaceId: workspace.id, path }),
    ).rejects.toThrow();
  }
  await expect(
    client.workspace.read({
      workspaceId: workspace.id,
      path: "linked/secret.tea",
    }),
  ).rejects.toThrow();
  await expect(
    client.workspace.write({
      workspaceId: workspace.id,
      path: "linked/new.tea",
      text: "no",
      expected: null,
    }),
  ).rejects.toThrow();
  await expect(readFile(join(outside, "new.tea"))).rejects.toThrow();
  await writeFile(join(workspace.root, "own.tea"), "own");
  for (const [from, to] of [
    ["linked", "moved"],
    ["linked/secret.tea", "moved.tea"],
    ["own.tea", "linked/own.tea"],
  ] as const)
    await expect(
      client.workspace.rename({ workspaceId: workspace.id, from, to }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(readFile(join(outside, "own.tea"))).rejects.toThrow();
});

test.each(["notes.md", "NOTES.MD", "notes.markdown", "notes.txt"])(
  "indexes, creates and saves %s with the existing disk conflict protection",
  async (path) => {
    const record = await ordinary();
    const input = { workspaceId: record.id, path };
    const text = "# Étude 📈\r\n\r\n- [ ] Review\r\n";
    const entry = await client.workspace.write({
      ...input,
      text,
      expected: null,
    });
    const read = await client.workspace.read(input);
    expect(Buffer.from(read.base64, "base64").toString("utf8")).toBe(text);
    await expect
      .poll(async () => {
        const snapshot = await client.workspace.listTree({
          workspaceId: record.id,
        });
        return (
          snapshot.status === "ready" &&
          snapshot.entries.some((file) => file.path === path)
        );
      })
      .toBe(true);
    const updated = await client.workspace.write({
      ...input,
      text: "# Edited\n",
      expected: entry.hash,
    });
    expect(await readFile(join(record.root, path), "utf8")).toBe("# Edited\n");
    await writeFile(join(record.root, path), "# External\n");
    await expect(
      client.workspace.write({ ...input, text, expected: updated.hash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(record.root, path), "utf8")).toBe(
      "# External\n",
    );
  },
);

test("creates and indexes empty directories, including later external changes", async () => {
  const record = await ordinary();
  const workspaceId = record.id;
  await client.workspace.mkdir({ workspaceId, path: "notes/empty" });
  expect((await stat(join(record.root, "notes/empty"))).isDirectory()).toBe(
    true,
  );
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toEqual({
      status: "ready",
      entries: [],
      directories: ["notes", "notes/empty"],
    });
  await client.workspace.mkdir({ workspaceId, path: "notes/empty" });
  const entry = await client.workspace.write({
    workspaceId,
    path: "notes/empty/main.tea",
    text: "close",
    expected: null,
  });
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toMatchObject({ entries: [{ path: entry.path }] });
  await client.workspace.remove({
    workspaceId,
    path: entry.path,
    expected: entry.hash,
  });
  await mkdir(join(record.root, "external"));
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toEqual({
      status: "ready",
      entries: [],
      directories: ["external", "notes", "notes/empty"],
    });
  await rm(join(record.root, "notes"), { recursive: true });
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toEqual({
      status: "ready",
      entries: [],
      directories: ["external"],
    });
});

test("mkdir rejects escapes, hidden paths, symlinks and files without overwriting them", async () => {
  const record = await ordinary();
  const workspaceId = record.id;
  const outside = join(home, "outside");
  await mkdir(outside);
  await symlink(outside, join(record.root, "linked"));
  await mkdir(join(record.root, "real"));
  await symlink(join(record.root, "real"), join(record.root, "alias"));
  await mkdir(join(record.root, ".hidden"));
  await writeFile(join(record.root, "existing.tea"), "keep");
  for (const path of [
    "",
    "../escape",
    "/escape",
    ".hidden/child",
    "nested/../escape",
    "nested\\child",
    "nested//child",
    "linked",
    "linked/child",
    "alias/child",
    "existing.tea",
    "existing.tea/child",
  ]) {
    await expect(
      client.workspace.mkdir({ workspaceId, path }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(await readFile(join(record.root, "existing.tea"), "utf8")).toBe(
    "keep",
  );
  await expect(stat(join(outside, "child"))).rejects.toThrow();
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toMatchObject({ directories: ["real"] });
});

test("observes external saves, missing and empty recovery, and ends old handles on forget", async () => {
  const record = await ordinary();
  const workspace = await runtime.runPromise(
    Effect.flatMap(Workspaces, (s) => s.open(record.id)),
  );
  await expect
    .poll(() => client.workspace.listTree({ workspaceId: record.id }))
    .toEqual({ status: "ready", entries: [], directories: [] });
  await writeFile(join(record.root, "a.tea"), "close");
  await expect
    .poll(
      async () => {
        const s = await client.workspace.listTree({ workspaceId: record.id });
        return s.status === "ready" ? s.entries.length : -1;
      },
      { timeout: 5000 },
    )
    .toBe(1);
  const subscription = runtime.runPromise(
    Stream.runCollect(workspace.watch({ kind: "directory", path: "" })),
  );
  await rm(record.root, { recursive: true });
  await expect
    .poll(
      async () =>
        (await client.workspace.listTree({ workspaceId: record.id })).status,
      { timeout: 8000 },
    )
    .toBe("missing");
  await mkdir(record.root);
  await expect
    .poll(() => client.workspace.listTree({ workspaceId: record.id }), {
      timeout: 12000,
    })
    .toEqual({ status: "ready", entries: [], directories: [] });
  await runtime.runPromise(
    Transactor.run(workspaceResource.transitions.forget({ id: record.id })),
  );
  await expect(
    runtime.runPromise(workspace.read(relative("a.tea"))),
  ).rejects.toThrow();
  await subscription;
  await expect(
    runtime.runPromise(
      workspace.mkdir(Schema.decodeUnknownSync(RelativePath)("after-forget")),
    ),
  ).rejects.toThrow();
  expect(await realpath(record.root)).toBe(record.root);
  await expect(
    client.workspace.listTree({ workspaceId: record.id }),
  ).rejects.toThrow();
}, 30000);

test("only one concurrent backend writer can commit the same expected hash", async () => {
  const workspaceId = await client.resources.workspace.getDefault();
  const original = await client.workspace.write({
    workspaceId,
    path: "a.tea",
    text: "first",
    expected: null,
  });
  const writes = await Promise.allSettled(
    ["second", "third"].map((text) =>
      client.workspace.write({
        workspaceId,
        path: original.path,
        text,
        expected: original.hash,
      }),
    ),
  );
  expect(writes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(writes.filter((x) => x.status === "rejected")).toHaveLength(1);
});

test("root replacement at the same path recovers and reads preserve non-UTF-8 bytes", async () => {
  const record = await ordinary();
  await expect
    .poll(() => client.workspace.listTree({ workspaceId: record.id }))
    .toEqual({ status: "ready", entries: [], directories: [] });
  await rename(record.root, join(home, "old"));
  await mkdir(record.root);
  await writeFile(join(record.root, "new.tea"), new Uint8Array([255]));
  await expect
    .poll(
      async () => {
        const s = await client.workspace.listTree({ workspaceId: record.id });
        return s.status === "ready" ? s.entries.map((e) => e.path) : [];
      },
      { timeout: 15000 },
    )
    .toEqual(["new.tea"]);
  await expect(
    client.workspace.read({ workspaceId: record.id, path: "new.tea" }),
  ).resolves.toMatchObject({
    mediaType: "application/octet-stream",
    base64: "/w==",
  });
  await writeFile(join(record.root, "new.tea"), "fixed");
  expect(
    (await client.workspace.read({ workspaceId: record.id, path: "new.tea" }))
      .base64,
  ).toBe(Buffer.from("fixed").toString("base64"));
}, 20000);

test("watcher errors close the old watcher before retrying and resume file observation", async () => {
  const defaultId = await client.resources.workspace.getDefault();
  await expect
    .poll(() => client.workspace.listTree({ workspaceId: defaultId }))
    .toMatchObject({ status: "ready" });
  const lifecycle: string[] = [];
  const originalAdd = FSWatcher.prototype.add;
  const watch = vi
    .spyOn(FSWatcher.prototype, "add")
    .mockImplementation(function (this: FSWatcher, ...args) {
      lifecycle.push("watch");
      return originalAdd.apply(this, args);
    });
  try {
    const record = await ordinary();
    await expect
      .poll(() => client.workspace.listTree({ workspaceId: record.id }))
      .toEqual({ status: "ready", entries: [], directories: [] });
    const notices = await observe(record.id);
    expect(watch).toHaveBeenCalledTimes(1);
    const firstWatch = watch.mock.results[0];
    if (!firstWatch || firstWatch.type !== "return")
      throw new Error("Expected the registered workspace's watcher");
    const watcher = firstWatch.value;
    const close = watcher.close.bind(watcher);
    vi.spyOn(watcher, "close").mockImplementation(async () => {
      lifecycle.push("closing");
      await close();
      lifecycle.push("closed");
    });
    const beforeError = notices.length;
    watcher.emit("error", new Error("watcher failed"));
    await expect.poll(() => notices.length).toBeGreaterThan(beforeError);
    await expect
      .poll(() => watch.mock.calls.length, { timeout: 10000 })
      .toBe(2);
    expect(lifecycle).toEqual(["watch", "closing", "closed", "watch"]);
    await writeFile(join(record.root, "after-retry.tea"), "close");
    await expect
      .poll(async () => {
        const snapshot = await client.workspace.listTree({
          workspaceId: record.id,
        });
        return snapshot.status === "ready"
          ? snapshot.entries.map((entry) => entry.path)
          : [];
      })
      .toEqual(["after-retry.tea"]);
  } finally {
    watch.mockRestore();
  }
}, 15000);

test("default recovery rejects a symlink and recreates the directory once it is removed", async () => {
  const workspaceId = await client.resources.workspace.getDefault();
  const root = join(home, "workspaces", "default");
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toMatchObject({ status: "ready" });
  await observe(workspaceId);
  const outside = join(home, "outside-default");
  await mkdir(outside);
  await writeFile(join(outside, "outside.tea"), "outside");
  await rename(root, join(home, "old-default"));
  await symlink(outside, root);
  await expect
    .poll(
      async () => (await client.workspace.listTree({ workspaceId })).status,
      { timeout: 12000 },
    )
    .toBe("unavailable");
  await expect(
    client.workspace.write({
      workspaceId,
      path: "new.tea",
      text: "no",
      expected: null,
    }),
  ).rejects.toThrow();
  await expect(readFile(join(outside, "new.tea"))).rejects.toThrow();
  await rm(root);
  await expect.poll(() => realpath(root), { timeout: 12000 }).toBe(root);
  await expect
    .poll(() => client.workspace.listTree({ workspaceId }))
    .toEqual({ status: "ready", entries: [], directories: [] });
  expect(await client.resources.workspace.getDefault()).toBe(workspaceId);
  expect(await readFile(join(outside, "outside.tea"), "utf8")).toBe("outside");
}, 30000);

test("unreadable artifact contents do not block directory listings or unrelated saves", async () => {
  const record = await ordinary();
  const hidden = join(record.root, ".git");
  const blocked = join(record.root, "blocked.tea");
  await mkdir(hidden);
  await writeFile(join(hidden, "ignored.tea"), "ignore");
  await writeFile(blocked, "cannot read");
  await chmod(hidden, 0);
  await chmod(blocked, 0);
  try {
    const entry = await client.workspace.write({
      workspaceId: record.id,
      path: "saved.tea",
      text: "saved",
      expected: null,
    });
    expect(
      (
        await client.workspace.read({
          workspaceId: record.id,
          path: entry.path,
        })
      ).base64,
    ).toBe(Buffer.from("saved").toString("base64"));
    await expect
      .poll(
        async () =>
          (await client.workspace.listTree({ workspaceId: record.id })).status,
      )
      .toBe("ready");
    await chmod(blocked, 0o600);
    await expect
      .poll(
        async () =>
          (await client.workspace.listTree({ workspaceId: record.id })).status,
        { timeout: 12000 },
      )
      .toBe("ready");
    const state = await client.workspace.listTree({ workspaceId: record.id });
    expect(
      state.status === "ready" &&
        state.entries.some((e) => e.path.includes(".git")),
    ).toBe(false);
  } finally {
    await chmod(hidden, 0o700);
    await chmod(blocked, 0o600);
  }
}, 20000);

test("shutdown waits for an admitted save, then closes old handles", async () => {
  const service = await runtime.runPromise(Workspaces);
  const defaultId = await client.resources.workspace.getDefault();
  const workspace = await runtime.runPromise(service.open(defaultId));
  const fs = await runtime.runPromise(FileSystem.FileSystem);
  const original = fs.writeFileString;
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const spy = vi
    .spyOn(fs, "writeFileString")
    .mockImplementation((filename, text, options) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* original(filename, text, options);
      }),
    );
  try {
    const save = runtime.runPromise(
      workspace.write(relative("draining.tea"), "committed", null),
    );
    await Effect.runPromise(Deferred.await(entered));
    let disposed = false;
    const close = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await expect(save).rejects.toThrow("All fibers interrupted");
    await close;
    expect(await readFile(join(workspace.root, "draining.tea"), "utf8")).toBe(
      "committed",
    );
    await expect(
      Effect.runPromise(workspace.read(relative("draining.tea"))),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
    await Effect.runPromise(Deferred.succeed(release, undefined));
  }
});

test("creates unnamed home workspaces through the same immutable registry", async () => {
  const record = await client.resources.workspace.createLocal();
  expect(record.root.startsWith(join(home, "workspaces") + "/")).toBe(true);
  const entry = await client.workspace.write({
    workspaceId: record.id,
    path: "local.tea",
    text: "close",
    expected: null,
  });
  await client.resources.workspace.forget({ id: record.id });
  expect(await readFile(join(record.root, entry.path), "utf8")).toBe("close");
});

test("reads any file type through one API without allowing binary writes or symlink escapes", async () => {
  const record = await ordinary();
  const files = [
    ["main.tea", Buffer.from("close // clôture 📈"), "text/plain"],
    ["task.workflow.ts", Buffer.from('export default "étude";'), "text/plain"],
    ["prices.csv", Buffer.from("symbol,close\nAAPL,1"), "text/plain"],
    ["Makefile", Buffer.from("all:\n\techo ok\n"), "text/plain"],
    [
      "book.xlsx",
      Buffer.from([0x50, 0x4b, 3, 4, 0, 0]),
      "application/octet-stream",
    ],
    ["report.pdf", Buffer.from("%PDF-1.7\npreview\n%%EOF"), "application/pdf"],
    [
      "chart.PNG",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]),
      "image/png",
    ],
  ] as const;
  for (const [path, bytes] of files)
    await writeFile(join(record.root, path), bytes);
  await expect
    .poll(async () => {
      const snapshot = await client.workspace.listTree({
        workspaceId: record.id,
      });
      return snapshot.status === "ready"
        ? snapshot.entries.map((entry) => entry.path)
        : [];
    })
    .toEqual([
      "book.xlsx",
      "chart.PNG",
      "main.tea",
      "Makefile",
      "prices.csv",
      "report.pdf",
      "task.workflow.ts",
    ]);
  for (const [path, bytes, mediaType] of files) {
    const file = await client.workspace.read({
      workspaceId: record.id,
      path,
    });
    expect(file.mediaType).toBe(mediaType);
    expect(file.entry).toEqual({
      path,
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(Buffer.from(file.base64, "base64")).toEqual(bytes);
    if (mediaType !== "text/plain") {
      await expect(
        client.workspace.write({
          workspaceId: record.id,
          path,
          text: "corrupt",
          expected: file.entry.hash,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await readFile(join(record.root, path))).toEqual(bytes);
  }
  const outside = join(home, "outside.pdf");
  await writeFile(outside, "%PDF-1.7\npreview\n%%EOF");
  await symlink(outside, join(record.root, "linked.pdf"));
  for (const path of ["linked.pdf", "../outside.pdf", ".hidden/report.pdf"]) {
    await expect(
      client.workspace.read({ workspaceId: record.id, path }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  await expect(
    client.workspace.read({ workspaceId: record.id, path: "missing.pdf" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("skips oversized files during scans and bounds direct reads even when the file grows after stat", async () => {
  const record = await ordinary();
  const oversized = join(record.root, "large.csv");
  await writeFile(oversized, "");
  await truncate(oversized, WORKSPACE_MEDIA_MAX_BYTES + 1);
  await writeFile(join(record.root, "chart.png"), "small image");
  await writeFile(join(record.root, "notes.md"), "small text");
  const fs = await runtime.runPromise(FileSystem.FileSystem);
  const streamSpy = vi.spyOn(fs, "stream");
  await expect
    .poll(async () => {
      const snapshot = await client.workspace.listTree({
        workspaceId: record.id,
      });
      return snapshot.status === "ready"
        ? snapshot.entries.map((entry) => entry.path).sort()
        : null;
    })
    .toEqual(["chart.png", "notes.md"]);
  await expect(
    client.workspace.read({ workspaceId: record.id, path: "large.csv" }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Workspace file exceeds the 32 MiB limit.",
  });
  expect(
    streamSpy.mock.calls.some(([filename]) => filename === oversized),
  ).toBe(false);
  expect(() => Schema.decodeUnknownSync(MediaPath)("notes.md")).toThrow();

  // Simulate a file that was small at stat time and grew before the read began.
  const originalStat = fs.stat;
  vi.spyOn(fs, "stat").mockImplementation((filename) =>
    originalStat(filename).pipe(
      Effect.map((info) =>
        filename === oversized ? { ...info, size: FileSystem.Size(1) } : info,
      ),
    ),
  );
  await expect(
    client.workspace.read({ workspaceId: record.id, path: "large.csv" }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Workspace file exceeds the 32 MiB limit.",
  });
  expect(streamSpy).toHaveBeenCalledWith(oversized, {
    bytesToRead: WORKSPACE_MEDIA_MAX_BYTES + 1,
  });
  expect((await stat(oversized)).size).toBe(WORKSPACE_MEDIA_MAX_BYTES + 1);
});

test("moves files and folders and deletes folders without overwriting entries or built-in originals", async () => {
  const record = await ordinary();
  const workspaceId = record.id;
  for (const path of ["a/one.tea", "a/b/two.md", "x.tea", "y.tea"])
    await client.workspace.write({
      workspaceId,
      path,
      text: path,
      expected: null,
    });
  await client.workspace.rename({ workspaceId, from: "a", to: "c/a2" });
  expect(await readFile(join(record.root, "c/a2/b/two.md"), "utf8")).toBe(
    "a/b/two.md",
  );
  await expect(stat(join(record.root, "a"))).rejects.toThrow();
  await client.workspace.mkdir({ workspaceId, path: "d" });
  for (const [from, to] of [
    ["c/a2", "d"],
    ["x.tea", "y.tea"],
    ["x.tea", "d"],
  ] as const)
    await expect(
      client.workspace.rename({ workspaceId, from, to }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A file or folder with that name already exists.",
    });
  expect(await readFile(join(record.root, "y.tea"), "utf8")).toBe("y.tea");
  await expect(
    client.workspace.rename({ workspaceId, from: "c", to: "c/x" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    client.workspace.rename({ workspaceId, from: "missing", to: "m" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Case-only renames succeed on case-insensitive disks too.
  await client.workspace.rename({ workspaceId, from: "d", to: "D" });
  await client.workspace.rename({ workspaceId, from: "x.tea", to: "X.tea" });
  // Files move into new folders, keeping their bytes.
  await client.workspace.rename({ workspaceId, from: "y.tea", to: "e/y.tea" });
  expect(await readFile(join(record.root, "e/y.tea"), "utf8")).toBe("y.tea");
  expect((await readdir(record.root)).sort()).toEqual(["D", "X.tea", "c", "e"]);
  await client.workspace.removeDirectory({ workspaceId, path: "c" });
  await client.workspace.removeDirectory({ workspaceId, path: "c" });
  expect((await readdir(record.root)).sort()).toEqual(["D", "X.tea", "e"]);

  const defaultId = await client.resources.workspace.getDefault();
  const workspace = await runtime.runPromise(
    Effect.flatMap(Workspaces, (service) => service.open(defaultId)),
  );
  const path = Schema.decodeUnknownSync(RelativePath);
  await runtime.runPromise(
    workspace.installBuiltin(
      Schema.decodeUnknownSync(RelPath)("templates/builtin/report.md"),
      "# Report",
    ),
  );
  const builtins = join(home, "workspaces", "default", "templates", "builtin");
  const before = (await readdir(builtins)).sort();
  expect(before).toEqual(["report.md"]);
  for (const attempt of [
    client.workspace.removeDirectory({
      workspaceId: defaultId,
      path: "templates",
    }),
    client.workspace.rename({
      workspaceId: defaultId,
      from: "templates/builtin",
      to: "moved",
    }),
  ])
    await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN" });
  // The protected side is reported, even when it is the target.
  await expect(
    runtime.runPromise(
      Effect.flip(
        workspace.rename(path("mine.md"), path("Templates/Builtin/Report.md")),
      ),
    ),
  ).resolves.toMatchObject({
    _tag: "WorkspaceFileProtected",
    path: "Templates/Builtin/Report.md",
  });
  expect((await readdir(builtins)).sort()).toEqual(before);
});
