// Purpose: Seed the default workspace with editable workflow files without replacing existing bytes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema } from "effect";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { Transactor } from "@openchart/server/lib/resource";
import { Workspaces } from "@openchart/server/workspace/workspace";
import { RelPath } from "@openchart/server/workspace/contract";

/**
 * Install missing shipped files at startup. Disk remains authoritative: edits
 * survive restarts, and deleted defaults are restored on the next startup.
 * This directory supplies files only, never executable definitions or IDs.
 * @example yield* ensureDefaultWorkflows();
 */
export const ensureDefaultWorkflows = Effect.fn("Workflow.ensureDefaults")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = fileURLToPath(new URL("./templates/", import.meta.url));
    const workspaceId = yield* Transactor.run(
      workspaceResource.transitions.getDefault(),
    );
    const workspace = yield* (yield* Workspaces).open(workspaceId);
    const files = yield* fs.readDirectory(directory);
    yield* Effect.forEach(
      files.filter((file) => file.endsWith(".workflow.ts")),
      (file) =>
        Effect.gen(function* () {
          const relative = yield* Schema.decodeUnknownEffect(RelPath)(
            `workflows/${file}`,
          );
          const source = yield* fs.readFileString(path.join(directory, file));
          yield* workspace.write(relative, source, null).pipe(
            // Create-only writes preserve existing files, including concurrent edits.
            Effect.catchTag("EntryStale", () => Effect.void),
          );
        }),
      { concurrency: "unbounded", discard: true },
    );
  },
);
