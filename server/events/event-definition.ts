// Purpose: Defines the typed identity, payload, and schema contract for application events.

import * as Identifier from "@openchart/identifier";
import { Schema } from "effect";

const EventID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
);

/** A process-unique event identifier with the `evt_` prefix. */
export type ID = typeof EventID.Type;

/**
 * Schema and constructor for event identifiers.
 *
 * @example
 * ```ts
 * const id = EventDefinition.ID.create();
 * ```
 */
export const ID = Object.assign(EventID, {
  create: (): ID => EventID.make(`evt_${Identifier.ascending()}`),
});

/** A typed event declaration owned by the feature that emits it. */
export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<
    unknown,
    unknown
  >,
> = Schema.Top & {
  readonly type: Type;
  readonly data: DataSchema;
};

/** The decoded data accepted by an event definition. */
export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>;

/** The envelope delivered to event subscribers. */
export type Payload<D extends Definition = Definition> = {
  readonly id: ID;
  readonly type: D["type"];
  readonly data: Data<D>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Creates one typed event definition and its complete payload schema.
 *
 * The returned schema also carries its literal `type` and data schema so the
 * publisher and subscribers share one declaration.
 *
 * @param input - Stable event type and Effect Schema fields for its data.
 * @returns A payload schema with static `type` and `data` members.
 *
 * @example
 * ```ts
 * const Renamed = EventDefinition.define({
 *   type: 'schedule.renamed',
 *   schema: {id: Schema.String, name: Schema.String},
 * });
 * ```
 */
export function define<
  const Type extends string,
  const Fields extends Readonly<
    Record<PropertyKey, Schema.Codec<unknown, unknown>>
  >,
>(input: { readonly type: Type; readonly schema: Fields }) {
  const data = Schema.Struct(input.schema);
  const payload = Schema.Struct({
    id: ID,
    type: Schema.Literal(input.type),
    data,
    metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }).annotate({ identifier: input.type });

  return Object.assign(payload, {
    type: input.type,
    data,
  }) satisfies Definition<Type, typeof data>;
}

/**
 * Collects feature-owned definitions without widening their tuple types.
 *
 * @param definitions - Event definitions contributed by one or more features.
 * @returns A frozen tuple suitable for composition or schema generation.
 *
 * @example
 * ```ts
 * const definitions = EventDefinition.inventory(Created, Updated, Deleted);
 * ```
 */
export function inventory<const Definitions extends ReadonlyArray<Definition>>(
  ...definitions: Definitions
): Readonly<Definitions> {
  return Object.freeze(definitions);
}
