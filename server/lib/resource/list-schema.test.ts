// Purpose: Locks derived list filters, annotation composition, and invalid key rejection.

import { defineId } from "@openchart/identifier";
import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test } from "vitest";

import {
  isListKey,
  isServerManaged,
  listKey,
  serverManaged,
} from "./annotation";
import { defineResource, STRICT_PARSE_OPTIONS } from "./definition";
import { envelopeFields } from "./envelope";
import { deriveListSchema, type ListFilter } from "./list-schema";
import type { Store } from "./store";
import { deriveWriteShape } from "./write-schema";
import type { WritableSchema } from "./write-schema";

function unused(): never {
  throw new Error("Schema tests must not access a store");
}

const store: Store = {
  load: unused,
  list: unused,
  insert: unused,
  save: unused,
  remove: unused,
};

test("derives optional constrained filters and composes markers in both orders", () => {
  const first = listKey(serverManaged(Schema.Int));
  const second = serverManaged(listKey(Schema.Int));
  for (const field of [first, second]) {
    expect(isListKey(field)).toBe(true);
    expect(isServerManaged(field)).toBe(true);
  }
  const entity = Schema.Struct({
    ...envelopeFields(defineId("ex", "Example.ID")),
    dashboardId: listKey(Schema.String.check(Schema.isMinLength(1))),
    first,
    second,
    unmarked: Schema.String,
  });
  const resource = defineResource({ name: "example", entity, store });
  const parse = Schema.decodeUnknownSync(
    resource.listSchema,
    STRICT_PARSE_OPTIONS,
  );
  expect(resource.listKeys).toEqual(["dashboardId", "first", "second"]);
  expect(parse({})).toEqual({});
  expect(
    parse({ filter: { dashboardId: "dsh_a", first: 0, second: 2 } }),
  ).toEqual({
    filter: {
      dashboardId: "dsh_a",
      first: 0,
      second: 2,
    },
  });
  for (const input of [
    { dashboardId: "" },
    { first: 1.5 },
    { unmarked: "x" },
    { revision: 1 },
  ]) {
    expect(() => parse({ filter: input })).toThrow();
  }
  expectTypeOf<ListFilter<typeof entity>>().toEqualTypeOf<{
    readonly dashboardId?: string;
    readonly first?: number;
    readonly second?: number;
  }>();
  expectTypeOf<keyof WritableSchema<typeof entity>["Type"]>().toEqualTypeOf<
    "dashboardId" | "unmarked"
  >();
  expect(() =>
    Schema.decodeUnknownSync(
      resource.createSchema,
      STRICT_PARSE_OPTIONS,
    )({ dashboardId: "x", unmarked: "y", first: 1 }),
  ).toThrow();
});

test("retains markers through checks and optional fields", () => {
  const entity = Schema.Struct({
    count: listKey(serverManaged(Schema.Int)).check(Schema.isGreaterThan(0)),
    label: Schema.optionalKey(listKey(Schema.String)),
  });
  const { schema, keys } = deriveListSchema(entity);
  expect(keys).toEqual(["count", "label"]);
  expectTypeOf<ListFilter<typeof entity>>().toEqualTypeOf<{
    readonly count?: number;
    readonly label?: string;
  }>();
  expectTypeOf<
    keyof ReturnType<typeof deriveWriteShape<typeof entity>>["schema"]["Type"]
  >().toEqualTypeOf<"label">();
  const parse = Schema.decodeUnknownSync(schema, STRICT_PARSE_OPTIONS);
  expect(parse({ label: "x" })).toEqual({ label: "x" });
  expect(() => parse({ count: 0 })).toThrow();
});

test("omitted defaults stay omitted and filtering uses canonical scalar values", () => {
  const entity = Schema.Struct({
    active: listKey(
      Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
    ),
    size: listKey(Schema.Int).pipe(
      Schema.withDecodingDefault(Effect.succeed(4)),
    ),
    code: listKey(Schema.NumberFromString),
    label: listKey(Schema.NullOr(Schema.String)),
  });
  const { schema, keys } = deriveListSchema(entity);
  const parse = Schema.decodeUnknownSync(schema, STRICT_PARSE_OPTIONS);
  expect(keys).toEqual(["active", "size", "code", "label"]);
  expect(parse({})).toEqual({});
  expect(parse({ active: false, size: 0, code: 2, label: null })).toEqual({
    active: false,
    size: 0,
    code: 2,
    label: null,
  });
  expect(() => parse({ code: "2" })).toThrow();
  expectTypeOf<typeof schema.Type>().toEqualTypeOf<{
    readonly active?: boolean;
    readonly size?: number;
    readonly code?: number;
    readonly label?: string | null;
  }>();
});

test("list derivation does not apply complete-entity checks to partial filters", () => {
  const entity = Schema.Struct({
    minimum: listKey(Schema.Int),
    maximum: Schema.Int,
  }).check(Schema.makeFilter((value) => value.minimum < value.maximum));
  const { schema } = deriveListSchema(entity);
  expect(Schema.decodeUnknownSync(schema)({ minimum: 3 })).toEqual({
    minimum: 3,
  });
});

test("resources without list keys accept only an empty object", () => {
  const { schema } = deriveListSchema(Schema.Struct({ name: Schema.String }));
  const parse = Schema.decodeUnknownSync(schema, STRICT_PARSE_OPTIONS);
  expect(parse({})).toEqual({});
  for (const input of [{ name: "x" }, [], null, 1, "x"])
    expect(() => parse(input)).toThrow();
});

test("composition rejects nested keys, including inside managed parents and collections", () => {
  const field = listKey(Schema.String);
  for (const nested of [
    Schema.Struct({ key: field }),
    serverManaged(Schema.Struct({ key: field })),
    Schema.Array(Schema.Struct({ key: field })),
    Schema.Record(Schema.String, field),
    Schema.Union([Schema.String, Schema.Struct({ key: field })]),
  ]) {
    expect(() =>
      defineResource({
        name: "example",
        entity: Schema.Struct({
          ...envelopeFields(defineId("ex", "Example.ID")),
          nested,
        }),
        store,
      }),
    ).toThrow("listKey must be on a top-level field");
  }
});

test("composition rejects non-scalar list fields", () => {
  for (const field of [
    Schema.Struct({ name: Schema.String }),
    Schema.Array(Schema.String),
    Schema.Unknown,
  ]) {
    // @ts-expect-error Non-scalar keys also fail at the annotation's type boundary.
    const annotated = listKey(field);
    expect(() => deriveListSchema(Schema.Struct({ field: annotated }))).toThrow(
      "listKey must be scalar",
    );
  }
});
