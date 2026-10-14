// Purpose: Load one trusted workspace file into the existing workflow runtime.
import path from "node:path";
import { compileFunction } from "node:vm";
import { Effect, Schema } from "effect";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import { Transactor } from "@openchart/server/lib/resource";
import { Workspaces } from "@openchart/server/workspace/workspace";
import { RelPath } from "@openchart/server/workspace/contract";
import { Workflow } from "./workflow";
import { LoadFailed } from "./errors";
import { compileWorkflow } from "./compile-workflow";
import * as authoring from "./authoring/index";
import type { Definition } from "./runtime";

const moduleSchema = Schema.Struct({
  default: Schema.Struct({
    kind: Schema.Literal("workflow"),
    description: Schema.String,
    execute: Schema.declare(
      (value): value is Definition["execute"] => typeof value === "function",
    ),
  }),
});

/**
 * Loads fresh bytes from the invocation's workspace or the explicit default workspace.
 * A file is a trusted single-file program importing only @openchart/workflow. The
 * compiler binds that import to the host's exact authoring instance, preserving Effect
 * services, tracing and cancellation. This is not a security sandbox. No ESM module
 * cache or global registration retains old source or mutable module state between calls.
 * @example const loaded = yield* loadWorkflow('workspace:research.workflow.ts');
 */
export const loadWorkflow = Effect.fn("Workflow.load")(function* (
  reference: string,
) {
  const host = yield* Workflow.Service;
  const workspaceId =
    reference.startsWith("default:") ||
    host.parentPrompt.workspaceId === undefined
      ? yield* Transactor.run(workspaceResource.transitions.getDefault())
      : yield* Schema.decodeUnknownEffect(WorkspaceId)(
          host.parentPrompt.workspaceId,
        );
  const workspace = yield* (yield* Workspaces).open(workspaceId);
  const relative = yield* Schema.decodeUnknownEffect(RelPath)(
    reference.slice(reference.indexOf(":") + 1),
  );
  const { entry, base64 } = yield* workspace.read(relative);
  const definition = yield* Effect.try({
    try: () =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(base64, "base64"),
      ),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((text) =>
      loadDefinitionFromSource(text, path.join(workspace.root, relative)),
    ),
    Effect.mapError(
      (cause) =>
        new LoadFailed({
          workflow: reference,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );
  return {
    definition,
    metadata: { workspaceId, path: relative, hash: entry.hash },
  };
});

const loadDefinitionFromSource = Effect.fn("Workflow.loadDefinitionFromSource")(
  function* (text: string, filename: string) {
    const compiled = yield* Effect.try({
      try: () => compileWorkflow(text, filename),
      catch: (cause) => cause,
    });
    const exports: Record<string, unknown> = {};
    yield* Effect.try({
      try: () =>
        compileFunction(compiled, ["require", "exports"], {
          filename,
        })((specifier: string) => {
          if (specifier !== "@openchart/workflow")
            throw new Error(
              "Workflow files may import only @openchart/workflow",
            );
          return authoring;
        }, exports),
      catch: (cause) => cause,
    });
    return (yield* Schema.decodeUnknownEffect(moduleSchema)(exports)).default;
  },
);
