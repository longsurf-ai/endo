// Purpose: Measure the real Workspace owner against a fixed, disposable large tree.
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { NodeFileSystem } from "@effect/platform-node";
import { Deferred, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { FSWatcher } from "chokidar";
import { expect, test, vi } from "vitest";
import { Events } from "@openchart/server/events";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import { makeWorkspace } from "./instance";
import { DirectoryPath, RelPath } from "./contract";

test.runIf(process.env.WORKSPACE_BENCHMARK === "1")(
  "large workspace benchmark",
  async () => {
    const root = await realpath(temporaryHome());
    const directories = 64;
    const filesPerDirectory = 128;
    const content = "x".repeat(8192);
    for (let directory = 0; directory < directories; directory++) {
      const folder = join(root, `folder-${directory}`);
      await mkdir(folder);
      await Promise.all(
        Array.from({ length: filesPerDirectory }, (_, file) =>
          writeFile(join(folder, `file-${file}.md`), content),
        ),
      );
    }
    const watchers = new Set<FSWatcher>();
    const add = FSWatcher.prototype.add;
    const spy = vi
      .spyOn(FSWatcher.prototype, "add")
      .mockImplementation(function (this: FSWatcher, ...args) {
        watchers.add(this);
        return add.apply(this, args);
      });
    const trials: unknown[] = [];
    try {
      for (let trial = 0; trial < 3; trial++) {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              let reads = 0;
              let bytes = 0;
              const measured: FileSystem.FileSystem = {
                ...fs,
                stream: (path, options) => {
                  reads++;
                  return fs.stream(path, options).pipe(
                    Stream.tap((chunk) =>
                      Effect.sync(() => {
                        bytes += chunk.byteLength;
                      }),
                    ),
                  );
                },
              };
              const start = performance.now();
              const workspace = yield* makeWorkspace(
                Schema.decodeUnknownSync(WorkspaceId)("wsp_benchmark"),
                root,
                false,
                Effect.void,
              ).pipe(Effect.provideService(FileSystem.FileSystem, measured));
              const rootReady = yield* Deferred.make<void>();
              const folderReady = yield* Deferred.make<void>();
              const edited = yield* Deferred.make<void>();
              const file =
                Schema.decodeUnknownSync(RelPath)("folder-0/file-0.md");
              let observingEdit = false;
              let originalHash = "";
              yield* workspace.watch({ kind: "directory", path: "" }).pipe(
                Stream.filter((revision) => revision > 0),
                Stream.runForEach(() => Deferred.succeed(rootReady, undefined)),
                Effect.forkScoped,
              );
              yield* workspace.watch({ kind: "file", path: file }).pipe(
                Stream.filter((revision) => revision > 0),
                Stream.runForEach(() =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(folderReady, undefined);
                    if (observingEdit) {
                      const current = yield* workspace.read(file);
                      if (current.entry.hash !== originalHash)
                        yield* Deferred.succeed(edited, undefined);
                    }
                  }),
                ),
                Effect.forkScoped,
              );
              while (
                !(yield* Deferred.isDone(rootReady)) ||
                !(yield* Deferred.isDone(folderReady))
              )
                yield* Effect.sleep("10 millis");
              yield* workspace.listDirectory("");
              yield* workspace.listDirectory(
                Schema.decodeUnknownSync(DirectoryPath)("folder-0"),
              );
              originalHash = (yield* workspace.read(file)).entry.hash;
              const initialMs = performance.now() - start;
              const initialReads = reads;
              const initialBytes = bytes;
              const watchedEntries = [...watchers].reduce(
                (sum, watcher) =>
                  sum +
                  Object.values(watcher.getWatched()).reduce(
                    (n, files) => n + files.length,
                    0,
                  ),
                0,
              );
              const editStart = performance.now();
              observingEdit = true;
              yield* Effect.promise(() =>
                writeFile(join(root, file), `${trial}${content}`),
              );
              while (!(yield* Deferred.isDone(edited)))
                yield* Effect.sleep("10 millis");
              trials.push({
                initialMs,
                initialReads,
                initialBytes,
                watchedEntries,
                editMs: performance.now() - editStart,
                editReads: reads - initialReads,
                editBytes: bytes - initialBytes,
              });
            }),
          ).pipe(
            Effect.provide(Layer.merge(NodeFileSystem.layer, Events.layer)),
          ),
        );
      }
      const result = {
        directories,
        filesPerDirectory,
        totalFiles: directories * filesPerDirectory,
        bytesPerFile: content.length,
        trials,
      };
      console.log(JSON.stringify(result, null, 2));
      if (process.env.WORKSPACE_BENCHMARK_OUTPUT)
        await writeFile(
          process.env.WORKSPACE_BENCHMARK_OUTPUT,
          JSON.stringify(result, null, 2),
        );
      expect(trials).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  },
  180_000,
);
