// Purpose: Derives Resource schemas and composes intrinsic operations with named custom transitions.

import type { IdSchema } from "@openchart/identifier";
import { Schema, Struct } from "effect";

import {
  createIntrinsicTransitions,
  type IntrinsicTransitions,
} from "./intrinsic-transitions";
import { ENVELOPE_FIELD_NAMES, type EnvelopeFields } from "./envelope";
import { isServerManaged, rebindWritableCheck } from "./annotation";
import type { Store, StoreBody } from "./store";
import { listInputSchema, type ListInputSchema } from "./pagination";
import * as Transition from "./transition";
import {
  deriveListSchema,
  type ListFields,
  type ListFilter,
} from "./list-schema";
import {
  deriveWriteShape,
  type WritableSchema,
  type WriteShape,
} from "./write-schema";

/**
 * Parse options for every Resource boundary.
 *
 * Unknown keys are rejected rather than stripped, so a write cannot smuggle a
 * field the schema does not declare into the stored body and a stored body
 * cannot carry one unnoticed.
 */
export const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

/**
 * A schema whose decoding and encoding need no Effect services.
 *
 * Resource values are plain JSON in and typed values out. Declaring that here
 * lets generic framework code decode any resource without carrying an unknown
 * service requirement.
 */
export interface PureCodec {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}

/** Everything the framework knows about one Resource. */
export interface ResourceDefinition<
  Name extends string = string,
  Fields extends Schema.Struct.Fields & EnvelopeFields<IdSchema> = Record<
    string,
    Schema.Constraint
  > &
    EnvelopeFields<IdSchema>,
  Custom extends Transition.Definitions = Record<never, never>,
  ReadOnly extends boolean = boolean,
> {
  /** Resource name: the tRPC child router and the event `resource`. */
  readonly name: Name;
  /** Optional authored description used in Agent Resource discovery. */
  readonly description?: string;
  /** Hides public intrinsic create/patch/delete; custom transitions and internal operations remain available. */
  readonly readOnly: ReadOnly;
  /** Branded identifier schema with its `create` constructor. */
  readonly id: Fields["id"];
  /**
   * Full domain read schema, derived from `entity` by omitting only the envelope
   * fields: `id`, `revision`, `createdAt`, and `updatedAt`.
   *
   * Retains all domain fields, including those marked `serverManaged`.
   * `createSchema` and `updateSchema` additionally exclude those fields
   * recursively to describe client-writable values.
   */
  readonly body: Schema.Struct<Omit<Fields, keyof EnvelopeFields<IdSchema>>> &
    PureCodec &
    Schema.Schema<Schema.JsonObject>;

  /**
   * Canonical runtime schema, declared once in the Resource's `entity.ts`.
   * Owns field types, constraints, annotations, and `withInvariants` rules.
   *
   * ```text
   * Complete Resource value
   * entity
   * |-- envelope: id, revision, createdAt, updatedAt
   * `-- domain:   writable fields + serverManaged fields
   *
   * Derived by defineResource (no parallel handwritten shapes)
   * entity
   * |-- body                       all domain fields (keeps serverManaged)
   * |-- createSchema/updateSchema  complete writable value only
   * |-- project                    writable value projection
   * `-- listSchema/listKeys        shared pagination + top-level listKey filters
   *
   * Intrinsic get/list/create/patch
   * tables --> Store --> envelope + body --> decode(entity)
   *                                         |-- valid --> parsed entity
   *                                         `-- invalid --> defect
   * ```
   *
   * Create/patch decode before commit; a defect rolls back their writes.
   */
  readonly entity: Schema.Struct<Fields> & PureCodec;

  /** Client create and replacement-body schemas; both exclude server-managed fields. */
  readonly createSchema: Schema.Codec<
    WritableSchema<Schema.Struct<Fields>>["Type"],
    WritableSchema<Schema.Struct<Fields>>["Encoded"]
  > &
    Schema.Schema<Schema.JsonObject>;
  readonly updateSchema: ResourceDefinition<Name, Fields>["createSchema"];
  /** Shared pagination input with equality filters derived from listKey annotations. */
  readonly listSchema: ListInputSchema<ListFields<Fields>> & PureCodec;
  /** Queryable field names, derived from entity annotations rather than configured. */
  readonly listKeys: ReadonlyArray<string>;

  /**
   * Projects an already-parsed Resource value to its client-writable fields.
   * Derived from the same entity as `createSchema` and `updateSchema`.
   *
   * ```text
   * entity --> deriveWriteShape
   *              |-- schema -----------> createSchema / updateSchema
   *              `-- project ----------> resource.project
   *
   * parsed body
   *   | project (remove serverManaged fields)
   *   v
   * writable document
   *   | apply JSON Patch
   *   v
   * final candidate --> updateSchema (all constraints) --> save
   * ```
   *
   * @param value - Parsed complete entity or domain body.
   * @returns A JSON value with server-managed fields recursively omitted.
   *
   * @example
   * ```ts
   * // For a Resource with writable `name` and server-managed `total`:
   * resource.project({name: 'A', total: 3}); // {name: 'A'}
   * ```
   */
  readonly project: WriteShape<Schema.Struct<Fields>>["project"];

  /**
   * The persistence seam. The framework never sees a table; it sees only this
   * interface, whether the Resource occupies one table or several.
   */
  readonly store: Store;
  /** Input-bound intrinsic and custom operations; constructing them performs no IO. */
  readonly transitions: IntrinsicTransitions<Pick<this, keyof ResourceShape>> &
    Transition.BoundDefinitions<Custom>;
  /** Canonical custom declarations; transports derive schemas and operations from these. */
  readonly transitionDefinitions: Custom;
}

/**
 * The schemas and Store consumed by intrinsic operations before binding.
 * Operations only decode the entity; its concrete Struct fields remain owned
 * by ResourceDefinition and are preserved through each operation's generic.
 */
export type ResourceShape = Omit<
  ResourceDefinition,
  "transitions" | "transitionDefinitions" | "entity" | "readOnly"
> & {
  readonly entity: Schema.Schema<unknown> & PureCodec;
};

/** The read shape of a resource: envelope plus domain fields. */
export type Entity<D extends ResourceShape> = D["entity"]["Type"];

/** The full domain read body, without the envelope. */
export type EntityBody<D extends ResourceShape> = D["body"]["Type"];

/** Client-writable data derived from the entity's field annotations. */
export type WritableEntityBody<D extends ResourceShape> =
  D["createSchema"]["Type"];

/** The branded identifier type of a resource. */
export type Id<D extends ResourceShape> = D["id"]["Type"];

/** Schemas, Store, and optional custom transitions supplied by a Resource folder. */
export interface DefineResourceInput<
  Name extends string,
  Fields extends Schema.Struct.Fields & EnvelopeFields<IdSchema>,
  Custom extends Transition.Definitions = Record<never, never>,
  ReadOnly extends boolean = false,
> {
  readonly name: Name;
  /** Optional authored description used in Agent Resource discovery. */
  readonly description?: string;
  /** Hides public intrinsic create/patch/delete; defaults to false. */
  readonly readOnly?: ReadOnly;
  /** Complete runtime entity, including the shared server-managed envelope. */
  readonly entity: Schema.Struct<Fields> &
    PureCodec &
    Schema.Schema<Schema.JsonObject>;
  readonly store: Store<
    NoInfer<StoreBody<Schema.Struct<Fields>>>,
    NoInfer<ListFilter<Schema.Struct<Fields>>>
  >;
  /** Custom operation names; omitted when a Resource only needs intrinsic CRUD. */
  readonly transitions?: Custom;
}

/**
 * Defines one Resource.
 *
 * The supplied entity is the complete runtime schema. Its envelope provides
 * the identifier constructor. Omitting the envelope derives the full domain
 * read body; recursively omitting server-managed fields derives both client
 * write schemas without a second entity definition. Top-level listKey annotations
 * derive optional equality filters and the public listKeys metadata.
 * Binds shared CRUD and custom declarations to their decoded inputs;
 * definition and transition construction perform no IO or id generation.
 *
 * @param input - Name, complete entity schema, Store, and named custom declarations.
 * @returns Schemas, canonical custom declarations, and bound operation factories.
 * @throws If an envelope field is not server-managed, a listKey is invalid, or a custom name is reserved.
 *
 * @example
 * ```ts
 * export const agentScheduleResource = defineResource({
 *   name: 'agent_schedule',
 *   entity: AgentScheduleEntity,
 *   store: agentScheduleStore,
 * });
 * ```
 */
export function defineResource<
  const Name extends string,
  const Fields extends Schema.Struct.Fields & EnvelopeFields<IdSchema>,
  const Custom extends Transition.Definitions = Record<never, never>,
  const ReadOnly extends boolean = false,
>(
  input: DefineResourceInput<Name, Fields, Custom, ReadOnly>,
): ResourceDefinition<Name, Fields, Custom, ReadOnly> {
  for (const name of ENVELOPE_FIELD_NAMES) {
    if (!isServerManaged(input.entity.fields[name])) {
      throw new Error(
        `Resource ${input.name} envelope field "${name}" must be server-managed`,
      );
    }
  }
  const writeShape = deriveWriteShape(input.entity);
  const list = deriveListSchema(input.entity);
  const fields = Struct.omit(input.entity.fields, ENVELOPE_FIELD_NAMES);
  // The input guarantees pure JSON fields; omitting the envelope preserves it.
  const bodyShape = Schema.Struct(fields);
  const body = (input.entity.ast.checks ?? []).reduce(
    (schema, check) => schema.check(rebindWritableCheck(check, bodyShape.ast)),
    bodyShape,
  ) as ResourceDefinition<Name, Fields>["body"];
  const writable = writeShape.schema as ResourceDefinition<
    Name,
    Fields
  >["createSchema"];
  const definition: Omit<
    ResourceDefinition<Name, Fields, Custom, ReadOnly>,
    "transitions" | "transitionDefinitions"
  > = {
    name: input.name,
    description: input.description,
    readOnly: (input.readOnly ?? false) as ReadOnly,
    id: input.entity.fields.id,
    body,
    entity: input.entity,
    createSchema: writable,
    updateSchema: writable,
    listSchema: listInputSchema(list.schema),
    listKeys: list.keys,
    project: writeShape.project,
    // The input binds the store's write type to the derived body schema.
    store: input.store as Store,
  };
  const intrinsic = createIntrinsicTransitions(definition);
  const custom = input.transitions ?? {};
  for (const name of Object.keys(custom)) {
    if (name in intrinsic || name === "delete") {
      throw new Error(
        `Resource ${input.name} transition "${name}" is reserved`,
      );
    }
  }
  // The absent declaration map is empty; explicit maps retain their exact keys.
  const transitionDefinitions = custom as Custom;
  return {
    ...definition,
    transitionDefinitions,
    transitions: { ...intrinsic, ...Transition.bind(transitionDefinitions) },
  };
}
