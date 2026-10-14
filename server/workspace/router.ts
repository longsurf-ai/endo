// Purpose: Parse workspace file requests once and run the shared runtime service.
import { Effect, Schema, Stream } from "effect";
import { trpc } from "@openchart/server/lib/trpc";
import { STRICT_PARSE_OPTIONS } from "@openchart/server/lib/resource";
import {
  ByWorkspace,
  ListDirectoryInput,
  WatchInput,
  MkdirInput,
  ReadInput,
  WriteInput,
  RemoveInput,
  RenameInput,
} from "./contract";
import { Workspaces } from "./workspace";

const parser = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
) => Schema.toStandardSchemaV1(schema, { parseOptions: STRICT_PARSE_OPTIONS });

/** File API; registration transitions are exposed under resources.workspace. */
export const workspaceRouter = trpc.router({
  watch: trpc.procedure
    .input(parser(WatchInput))
    .subscription(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(
        Stream.toAsyncIterableEffect(
          Stream.unwrap(
            Effect.map(Workspaces, (workspaces) =>
              workspaces.watch(input.interests),
            ),
          ).pipe(
            // Abort the Effect scope directly: an async generator's return can wait
            // for the next SSE heartbeat while its current pull is pending.
            Stream.interruptWhen(
              Effect.suspend(() =>
                signal?.aborted
                  ? Effect.void
                  : signal
                    ? Stream.fromEventListener(signal, "abort").pipe(
                        Stream.take(1),
                        Stream.runDrain,
                      )
                    : Effect.never,
              ),
            ),
          ),
        ),
      ),
    ),
  mkdir: trpc.procedure.input(parser(MkdirInput)).mutation(({ ctx, input }) =>
    ctx.runtime.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const workspace = yield* workspaces.open(input.workspaceId);
        return yield* workspace.mkdir(input.path);
      }),
    ),
  ),
  listDirectory: trpc.procedure
    .input(parser(ListDirectoryInput))
    .query(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const workspace = yield* workspaces.open(input.workspaceId);
          return yield* workspace.listDirectory(input.path);
        }),
        { signal },
      ),
    ),
  listTree: trpc.procedure
    .input(parser(ByWorkspace))
    .query(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const workspace = yield* workspaces.open(input.workspaceId);
          return yield* workspace.listTree;
        }),
        { signal },
      ),
    ),
  read: trpc.procedure
    .input(parser(ReadInput))
    .query(({ ctx, input, signal }) =>
      ctx.runtime.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const workspace = yield* workspaces.open(input.workspaceId);
          return yield* workspace.read(input.path);
        }),
        { signal },
      ),
    ),
  write: trpc.procedure.input(parser(WriteInput)).mutation(({ ctx, input }) =>
    ctx.runtime.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const workspace = yield* workspaces.open(input.workspaceId);
        return yield* workspace.write(input.path, input.text, input.expected);
      }),
    ),
  ),
  remove: trpc.procedure.input(parser(RemoveInput)).mutation(({ ctx, input }) =>
    ctx.runtime.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const workspace = yield* workspaces.open(input.workspaceId);
        return yield* workspace.remove(input.path, input.expected);
      }),
    ),
  ),
  removeDirectory: trpc.procedure
    .input(parser(MkdirInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const workspace = yield* workspaces.open(input.workspaceId);
          return yield* workspace.removeDirectory(input.path);
        }),
      ),
    ),
  rename: trpc.procedure.input(parser(RenameInput)).mutation(({ ctx, input }) =>
    ctx.runtime.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const workspace = yield* workspaces.open(input.workspaceId);
        return yield* workspace.rename(input.from, input.to);
      }),
    ),
  ),
});
