// Purpose: Derives the tRPC surface of a Resource from its definition; no resource writes a router by hand.

import {
  Patch,
  type ResourceDefinition,
  ResourceStateInvalid,
  Revision,
  STRICT_PARSE_OPTIONS,
  Transactor,
  Transition,
  resourceIssues,
} from "@openchart/server/lib/resource";
import { TRPCError } from "@trpc/server";
import { Cause, Effect, Exit, Option, Schema, Struct } from "effect";
import type { ManagedRuntime } from "effect/ManagedRuntime";
import type { StandardSchemaV1 } from "effect/StandardSchema";

import type { Context } from "@openchart/server/context";
import { trpc } from "./trpc";

type RuntimeServices = ManagedRuntime.Services<Context["runtime"]>;

/** Resources exposed by this adapter can only require the application runtime's services. */
type RoutableResource = ResourceDefinition & {
  readonly transitionDefinitions: Transition.Definitions<RuntimeServices>;
};

function transitionProcedure<
  D extends Transition.AnyDefinition<RuntimeServices>,
>(definition: D) {
  const procedure = trpc.procedure.input(
    Schema.toStandardSchemaV1<D["input"]>(definition.input, {
      parseOptions: STRICT_PARSE_OPTIONS,
    }),
  );
  const resolve = ({
    ctx,
    input,
    signal,
  }: {
    ctx: Context;
    input: D["input"]["Type"];
    signal?: AbortSignal;
  }) =>
    ctx.runtime.runPromise(
      Transactor.run(Transition.bindInput(definition, input)),
      { signal },
    );
  type Output = Awaited<ReturnType<typeof resolve>>;
  // Preserve each declaration's kind in the generated client, not a query/mutation union.
  return (
    definition.kind === "query"
      ? procedure.query(resolve)
      : procedure.mutation(resolve)
  ) as NonNullable<D["kind"]> extends "query"
    ? ReturnType<typeof procedure.query<Output>>
    : ReturnType<typeof procedure.mutation<Output>>;
}

function transitionProcedures<
  D extends Transition.Definitions<RuntimeServices>,
>(definitions: D) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      transitionProcedure(definition),
    ]),
  ) as {
    [K in keyof D]: ReturnType<typeof transitionProcedure<D[K]>>;
  };
}

/**
 * Builds a Resource's intrinsic routes and named custom queries or mutations.
 * Read-only Resources omit intrinsic create/patch/delete in runtime and generated
 * types; custom operations and complete internal transitions/Stores remain available.
 *
 * Inputs are parsed once by the resource's own schemas through Standard
 * Schema. The create adapter preserves encoded input types and structured
 * Effect diagnostics. Every transition receives decoded typed values. Custom
 * declarations retain their own input/result types and require only services
 * available in the application runtime. Typed
 * failures pass unchanged to the shared tRPC error boundary, which owns their
 * public codes and details.
 *
 * @param definition - The resource.
 * @returns A child router to mount under the Resource name.
 *
 * @example
 * ```ts
 * const router = resourceRouter(agentScheduleResource);
 * ```
 */
export function resourceRouter<D extends RoutableResource>(definition: D) {
  const parseOptions = STRICT_PARSE_OPTIONS;
  const ListInput = Schema.toStandardSchemaV1<Schema.optional<D["listSchema"]>>(
    Schema.optional<D["listSchema"]>(definition.listSchema),
    { parseOptions },
  );
  const ById = Schema.toStandardSchemaV1(Schema.Struct({ id: definition.id }), {
    parseOptions,
  });
  const PatchInput = Schema.toStandardSchemaV1(
    Schema.Struct({
      id: definition.id,
      expectedRevision: Revision,
      operations: Patch,
    }),
    { parseOptions },
  );
  const decodeCreate = Schema.decodeUnknownEffect<D["createSchema"]>(
    definition.createSchema,
    parseOptions,
  );
  const CreateInput: StandardSchemaV1<
    D["createSchema"]["Encoded"],
    D["createSchema"]["Type"]
  > = {
    "~standard": {
      version: 1,
      vendor: "openchart",
      validate: async (input) => {
        const parsed = await Effect.runPromiseExit(
          Effect.suspend(() => decodeCreate(input)),
        );
        if (Exit.isSuccess(parsed)) return { value: parsed.value };
        const failure = Cause.findErrorOption(parsed.cause);
        if (Option.isSome(failure)) {
          throw new ResourceStateInvalid({
            resource: definition.name,
            reason: failure.value.message,
            issues: resourceIssues(failure.value.issue),
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          cause: Cause.squash(parsed.cause),
        });
      },
    },
  };

  const procedures = {
    ...transitionProcedures<D["transitionDefinitions"]>(
      definition.transitionDefinitions,
    ),
    get: trpc.procedure
      .input(ById)
      .query(({ ctx, input }) =>
        ctx.runtime.runPromise(
          Transactor.run(definition.transitions.get(input.id)),
        ),
      ),
    list: trpc.procedure
      .input(ListInput)
      .query(({ ctx, input }) =>
        ctx.runtime.runPromise(
          Transactor.run(definition.transitions.list(input)),
        ),
      ),
    create: trpc.procedure
      .input(CreateInput)
      .mutation(({ ctx, input }) =>
        ctx.runtime.runPromise(
          Transactor.run(definition.transitions.create(input)),
        ),
      ),
    patch: trpc.procedure
      .input(PatchInput)
      .mutation(({ ctx, input }) =>
        ctx.runtime.runPromise(
          Transactor.run(definition.transitions.patch(input)),
        ),
      ),
    delete: trpc.procedure
      .input(ById)
      .mutation(({ ctx, input }) =>
        ctx.runtime.runPromise(
          Transactor.run(definition.transitions.remove(input.id)),
        ),
      ),
  };
  const selected = definition.readOnly
    ? Struct.omit(procedures, ["create", "patch", "delete"])
    : procedures;
  return trpc.router(
    selected as D["readOnly"] extends false
      ? typeof procedures
      : Omit<typeof procedures, "create" | "patch" | "delete">,
  );
}

/** The router type produced by {@link resourceRouter} for one definition. */
export type ResourceRouter<D extends RoutableResource> = ReturnType<
  typeof resourceRouter<D>
>;

/**
 * Derives one child router per resource, keyed by resource name.
 *
 * @param resources - The server's complete resource list.
 * @returns Child routers to aggregate under the `resources` namespace.
 *
 * @example
 * ```ts
 * const resourceRouter = trpc.router(resourceRouters(resources));
 * export const router = trpc.router({resources: resourceRouter});
 * ```
 */
export function resourceRouters<
  const Resources extends ReadonlyArray<RoutableResource>,
>(
  resources: Resources,
): {
  readonly [D in Resources[number] as D["name"]]: ResourceRouter<D>;
} {
  return Object.fromEntries(
    resources.map((definition) => [
      definition.name,
      resourceRouter(definition),
    ]),
  ) as {
    readonly [D in Resources[number] as D["name"]]: ResourceRouter<D>;
  };
}
