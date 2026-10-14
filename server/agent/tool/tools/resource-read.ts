// Purpose: Reads canonical Resource entities, lists, and intrinsic input schemas for the Agent.

import * as Tool from "@openchart/server/agent/tool/tool";
import {
  Patch,
  STRICT_PARSE_OPTIONS,
  Transactor,
  type ResourceDefinition,
} from "@openchart/server/lib/resource";
import {
  listInputSchema,
  MAX_PAGE_SIZE,
} from "@openchart/server/lib/resource/pagination";
import { ResourceName } from "@openchart/server/resources/catalog";
import { Effect, JsonSchema, Schema, Struct } from "effect";
import { ask, parse, result, select } from "./resource-shared";

const id = Schema.String;
const include_schema = Schema.optionalKey(Schema.Boolean);
const pagination = listInputSchema(Schema.Struct({})).fields;
const cursor = Schema.toEncoded(pagination.cursor);
const Read = Schema.Union([
  Schema.Struct({
    resource: ResourceName,
    include_schema: Schema.Literal(true),
    limit: Schema.Literal(0),
  }),
  Schema.Struct({ resource: ResourceName, id, include_schema }),
  Schema.Struct({
    resource: ResourceName,
    filter: Schema.optionalKey(Schema.JsonObject),
    limit: pagination.limit,
    cursor,
    order: pagination.order,
    orderBy: pagination.orderBy,
    include_schema,
  }),
]).annotate({ parseOptions: STRICT_PARSE_OPTIONS });
// Providers receive an object schema; operation-dependent fields are parsed below.
const ReadParameters = Schema.Struct({
  resource: ResourceName,
  id: Schema.optionalKey(id),
  include_schema,
  filter: Schema.optionalKey(Schema.JsonObject),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_PAGE_SIZE })),
  ),
  cursor,
  order: pagination.order,
  orderBy: pagination.orderBy,
}).annotate({ parseOptions: STRICT_PARSE_OPTIONS });

function jsonSchema(schema: Schema.Top) {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(schema),
  );
  return { ...document.schema, definitions: document.definitions };
}

function schemas(definition: ResourceDefinition) {
  return {
    entity: jsonSchema(Schema.toType(definition.entity)),
    listKeys: definition.listKeys,
    transitions: definition.readOnly
      ? {}
      : {
          create: jsonSchema(definition.createSchema),
          patch: jsonSchema(Patch),
          delete: jsonSchema(Schema.Struct({ id: definition.id })),
        },
  };
}

/**
 * Reads schemas, full entities, or bounded lists; discovery exposes only intrinsic mutations.
 * Examples show JSON arguments to `resource_read`. Replace example IDs with
 * IDs returned by previous reads, searches, or creates.
 *
 * @example Inspect the schedule schema before writing, alongside one saved schedule.
 * ```json
 * {"resource": "agent_schedule", "limit": 1, "include_schema": true}
 * ```
 * Success returns `items`, `nextCursor`, and `schema` containing `entity`,
 * `listKeys`, and intrinsic mutation input schemas under `transitions`.
 * The schema is returned even when the schedule list is empty.
 *
 * @example Read one schedule and its latest revision before a patch.
 * ```json
 * {"resource": "agent_schedule", "id": "ags_morning"}
 * ```
 * Success returns `entity`; use its `revision` as the patch's `expected_revision`.
 * An ID read cannot also specify `filter`, `limit`, `cursor`, `order`, or `orderBy`.
 *
 * @example List a schedule's occurrences using the occurrence's declared scheduleId filter.
 * ```json
 * {
 *   "resource": "agent_schedule_occurrence",
 *   "filter": {"scheduleId": "ags_morning"},
 *   "limit": 20
 * }
 * ```
 * Success returns `items` and `nextCursor`. Only keys in the Resource's
 * `listKeys` are accepted; agent_schedule itself has no filter keys.
 *
 * @example Read the five most recently updated schedules.
 * ```json
 * {"resource": "agent_schedule", "limit": 5, "orderBy": "updatedAt", "order": "desc"}
 * ```
 * Lists default to `orderBy: "createdAt"` and `order: "asc"`.
 *
 * @example Continue that occurrence list using its returned opaque nextCursor token.
 * ```json
 * {
 *   "resource": "agent_schedule_occurrence",
 *   "filter": {"scheduleId": "ags_morning"},
 *   "limit": 20,
 *   "cursor": "eyJjcmVhdGVkQXQiOjE3ODkxNjQzODk0NzAsImlkIjoiY2h0X3ByaWNlIn0"
 * }
 * ```
 * Copy the returned `nextCursor` unchanged and keep the same filter, order and orderBy.
 * The token above is illustrative; do not decode or construct cursor tokens.
 * Stop when `nextCursor` is null; omit `cursor` for the first page.
 *
 * @example List all schedules by reading every page without a filter.
 * ```json
 * {"resource": "agent_schedule"}
 * ```
 * This returns the first page, with a default limit of 50. If `nextCursor`
 * is non-null, pass its exact value as `cursor` in the next request:
 * ```json
 * {
 *   "resource": "agent_schedule",
 *   "cursor": "eyJjcmVhdGVkQXQiOjE3ODkxNjQzODk0NzAsImlkIjoiZHNoX3JhdGVzIn0"
 * }
 * ```
 * The cursor above is illustrative. Collect `items` from each page and
 * continue until `nextCursor` is null to obtain the complete list.
 *
 * @example Request only the schema, without reading any entity examples.
 * ```json
 * {"resource": "agent_schedule", "include_schema": true, "limit": 0}
 * ```
 * Success returns only `status`, `resource`, and `schema` after the read
 * permission check. A positive limit also returns up to that many examples
 * in `items`, plus `nextCursor`; omitting limit keeps the default of 50.
 * A limit of 0 requires `include_schema: true` and excludes id/filter/cursor/order/orderBy.
 */
export const ResourceReadTool = Tool.define(
  "resource_read",
  Effect.succeed({
    description:
      "Read a Resource by resource and id, or list with filter/limit/cursor/order/orderBy. Lists default to createdAt ascending; use orderBy: updatedAt and order: desc for most recently updated first. ID reads cannot include list parameters. include_schema returns the entity schema, listKeys and intrinsic mutation input schemas. With include_schema: true, limit: 0 returns only schema (no id/filter/cursor/order/orderBy); a positive limit also returns entity examples. Omitted limit defaults to 50. Follow nextCursor unchanged with the same filter, order and orderBy for more results.",
    parameters: ReadParameters,
    execute: (args: typeof ReadParameters.Type, context: Tool.Context) =>
      result(
        "Read resource",
        Effect.gen(function* () {
          const input = yield* parse(Read, args);
          const definition = select(input.resource);
          yield* ask(context, "resource_read", [input.resource], {
            resource: input.resource,
          });
          const schema = input.include_schema
            ? { schema: schemas(definition) }
            : {};
          if ("id" in input) {
            const id = yield* parse(definition.id, input.id);
            const entity = yield* Transactor.run(
              definition.transitions.get(id),
            );
            return { resource: definition.name, entity, ...schema };
          }
          // Schema-only reads use the Resource definition, never stored entities.
          if (input.limit === 0)
            return { resource: definition.name, ...schema };
          const query = Struct.omit(input, ["resource", "include_schema"]);
          const parsed = yield* parse(
            definition.listSchema,
            query,
            definition.listKeys,
          );
          const page = yield* Transactor.run(
            definition.transitions.list(parsed),
          );
          return { resource: definition.name, ...page, ...schema };
        }),
      ),
  }),
);
