// Purpose: Adapt a server consumer's derived file set to scoped Workspace observations.
import path from "node:path";
import { Effect, Schema, Stream } from "effect";
import { Database } from "@openchart/server/db";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { RelPath, type DirectoryPath } from "./contract";
import { Workspaces } from "./workspace";

/**
 * Follows the files a consumer currently uses. Workspace resolves registrations,
 * shares observations, and releases obsolete interests. Unregistered files are
 * outside this service's ownership. Repeated dependency facts cost no new I/O.
 * @example observeWorkspaceFiles(compilerDependencies).pipe(Stream.runForEach(refresh));
 */
export function observeWorkspaceFiles<E, R>(
  files: Stream.Stream<readonly string[], E, R>,
) {
  return files.pipe(
    Stream.changesWith(
      (left, right) =>
        left.length === right.length &&
        left.every((file, index) => file === right[index]),
    ),
    Stream.switchMap((filenames) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (filenames.length === 0) return Stream.empty;
          const { db } = yield* Database.Service;
          const workspaces = yield* Workspaces;
          const records = yield* db.transaction((tx) =>
            workspaceResource.transitions.listAll().apply(tx, undefined),
          );
          const interests = records.flatMap((record) => {
            const directories = new Set<DirectoryPath>();
            for (const filename of filenames) {
              const relative = path
                .relative(record.root, filename)
                .split(path.sep)
                .join("/");
              if (Schema.is(RelPath)(relative))
                directories.add(
                  relative.split("/").slice(0, -1).join("/") as DirectoryPath,
                );
            }
            return [...directories].map((directory) => ({
              workspaceId: record.id,
              target: { kind: "directory" as const, path: directory },
            }));
          });
          return workspaces.watch(interests).pipe(Stream.map(() => undefined));
        }),
      ),
    ),
    Stream.debounce("50 millis"),
  );
}
