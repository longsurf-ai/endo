// Purpose: Locks the Resource definition's JSON object constraint at the type boundary.

import { defineId } from "@openchart/identifier";
import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test } from "vitest";

import {
  type DefineResourceInput,
  type ResourceDefinition,
  defineResource,
  STRICT_PARSE_OPTIONS,
} from "./definition";
import { envelopeFields } from "./envelope";
import { serverManaged } from "./annotation";
import type { Store, StoreBody } from "./store";
import * as Transition from "./transition";

test("resource schemas accept JSON objects and reject non-JSON fields", () => {
  const envelope = envelopeFields(defineId("ex", "Example.ID"));
  const json = Schema.Struct({
    ...envelope,
    name: Schema.String,
    widgets: Schema.Array(Schema.Struct({ id: Schema.String })),
  });
  const date = Schema.Struct({ ...envelope, date: Schema.Date });
  const bigint = Schema.Struct({ ...envelope, count: Schema.BigInt });

  expectTypeOf(json).toExtend<ResourceDefinition["body"]>();
  expectTypeOf(date).not.toExtend<ResourceDefinition["body"]>();
  expectTypeOf(bigint).not.toExtend<ResourceDefinition["body"]>();
  expectTypeOf(json).toExtend<
    DefineResourceInput<"example", typeof json.fields>["entity"]
  >();
  expectTypeOf(date).not.toExtend<
    DefineResourceInput<"example", typeof date.fields>["entity"]
  >();
  expectTypeOf(bigint).not.toExtend<
    DefineResourceInput<"example", typeof bigint.fields>["entity"]
  >();
});

test("binds the store write type to the domain entity", () => {
  const entity = Schema.Struct({
    ...envelopeFields(defineId("ex", "Example.ID")),
    name: Schema.String,
  });
  expectTypeOf(entity).toExtend<ResourceDefinition["entity"]>();
  type EntityStore = DefineResourceInput<
    "example",
    typeof entity.fields
  >["store"];

  expectTypeOf<Store<{ name: string }>>().toExtend<EntityStore>();
  expectTypeOf<Store<{ count: number }>>().not.toExtend<EntityStore>();
});

test("store writes accept full internal bodies as well as client-writable projections", () => {
  const entity = Schema.Struct({
    ...envelopeFields(defineId("ex", "Example.ID")),
    name: Schema.String,
    total: serverManaged(Schema.Number),
    nested: Schema.Struct({
      label: Schema.String,
      count: serverManaged(Schema.Number),
    }),
  });
  type Body = StoreBody<typeof entity>;
  expectTypeOf(entity).toExtend<ResourceDefinition["entity"]>();
  expectTypeOf<Body>().toEqualTypeOf<
    | {
        readonly name: string;
        readonly total: number;
        readonly nested: { readonly label: string; readonly count: number };
      }
    | { readonly name: string; readonly nested: { readonly label: string } }
  >();
  expectTypeOf<Store<Body>>().toExtend<
    DefineResourceInput<"example", typeof entity.fields>["store"]
  >();
});

test("derives writes from the complete entity and rejects writable envelope fields", () => {
  const id = defineId("ex", "Example.ID");
  const entity = Schema.Struct({ ...envelopeFields(id), name: Schema.String });
  const unused = () => {
    throw new Error("Store must not run during composition");
  };
  const store: Store<{ name: string }> = {
    load: unused,
    list: unused,
    insert: unused,
    save: unused,
    remove: unused,
  };
  const resource = defineResource({ name: "example", entity, store });
  const custom = Transition.make({
    input: Schema.String,
    resolve: () => Effect.void,
    apply: (_tx, input) => Effect.succeed(input.length),
  });
  const extended = defineResource({
    name: "example",
    entity,
    store,
    transitions: { measure: custom },
  });
  expect(extended.transitionDefinitions.measure).toBe(custom);
  expectTypeOf<
    Parameters<typeof extended.transitions.measure>[0]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    Effect.Success<
      ReturnType<ReturnType<typeof extended.transitions.measure>["apply"]>
    >
  >().toEqualTypeOf<number>();
  for (const name of [
    "get",
    "list",
    "listAll",
    "create",
    "patch",
    "remove",
    "delete",
  ]) {
    expect(() =>
      defineResource({
        name: "example",
        entity,
        store,
        transitions: { [name]: custom },
      }),
    ).toThrow(`transition "${name}" is reserved`);
  }
  expect(resource.entity).toBe(entity);
  expect(resource.id.create()).toMatch(/^ex_/);
  expectTypeOf(resource.id.create()).toEqualTypeOf<typeof id.Type>();
  const decode = Schema.decodeUnknownSync(resource.body, STRICT_PARSE_OPTIONS);
  expect(decode({ name: "Example" })).toEqual({ name: "Example" });
  for (const field of ["id", "revision", "createdAt", "updatedAt"]) {
    expect(() => decode({ name: "Example", [field]: 1 })).toThrow();
  }
  expect(() =>
    defineResource({
      name: "example",
      entity: Schema.Struct({
        ...entity.fields,
        revision: Schema.Int,
      }) as typeof entity,
      store,
    }),
  ).toThrow('envelope field "revision" must be server-managed');
});
