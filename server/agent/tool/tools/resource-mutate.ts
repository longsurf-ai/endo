// Purpose: Executes intrinsic Resource create, patch, and delete tools through existing approvals.

import * as Tool from "@openchart/server/agent/tool/tool";
import {
  Patch,
  Revision,
  STRICT_PARSE_OPTIONS,
  Transactor,
} from "@openchart/server/lib/resource";
import { ResourceName } from "@openchart/server/resources/catalog";
import { Effect, Schema } from "effect";
import { ResourceArgumentsError } from "./errors";
import { ask, parse, result, select } from "./resource-shared";

const id = Schema.String;
const Mutate = Schema.Union([
  Schema.Struct({
    resource: ResourceName,
    op: Schema.Literal("create"),
    input: Schema.JsonObject,
  }),
  Schema.Struct({
    resource: ResourceName,
    id,
    op: Schema.Literal("patch"),
    input: Patch,
    expected_revision: Revision,
  }),
  Schema.Struct({ resource: ResourceName, id, op: Schema.Literal("delete") }),
]).annotate({ parseOptions: STRICT_PARSE_OPTIONS });
// Providers receive an object schema; operation-dependent fields are parsed below.
const MutateParameters = Schema.Struct({
  resource: ResourceName,
  id: Schema.optionalKey(id),
  op: Schema.Literals(["create", "patch", "delete"]),
  input: Schema.optionalKey(Schema.Json),
  expected_revision: Schema.optionalKey(Revision),
}).annotate({ parseOptions: STRICT_PARSE_OPTIONS });

/** Runs only intrinsic client writes, preserving read-only Resources and transactional revisions.
 * @example
 * const tool = yield* Tool.init(yield* ResourceMutateTool);
 * const output = yield* tool.execute({resource: 'agent_schedule', op: 'create', input: {name: 'Rates'}}, context);
 */
export const ResourceMutateTool = Tool.define(
  "resource_mutate",
  Effect.succeed({
    description:
      "Create, patch or delete a Resource. Create takes writable input and assigns an id. Patch takes RFC 6902 input and the expected_revision from a fresh read. Delete takes id. Custom transitions and read-only Resources cannot be mutated. Approval waits in this invocation.",
    parameters: MutateParameters,
    execute: (args: typeof MutateParameters.Type, context: Tool.Context) =>
      result(
        "Mutate resource",
        Effect.gen(function* () {
          const input = yield* parse(Mutate, args);
          const definition = select(input.resource);
          if (definition.readOnly)
            return yield* new ResourceArgumentsError({
              detail: `${definition.name} is read-only.`,
            });
          if (input.op === "create") {
            const body = yield* parse(definition.createSchema, input.input);
            yield* ask(context, "resource_mutate", [input.resource], input);
            const entity = yield* Transactor.run(
              definition.transitions.create(body),
            );
            return { resource: definition.name, entity };
          }
          const id = yield* parse(definition.id, input.id);
          yield* ask(context, "resource_mutate", [input.resource], input);
          if (input.op === "delete") {
            yield* Transactor.run(definition.transitions.remove(id));
            return { resource: definition.name, id };
          }
          const entity = yield* Transactor.run(
            definition.transitions.patch({
              id,
              expectedRevision: input.expected_revision,
              operations: input.input,
            }),
          );
          return { resource: definition.name, entity };
        }),
      ),
  }),
);
