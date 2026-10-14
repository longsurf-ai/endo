// Purpose: Proves recursive server-managed exclusion without weakening writable field types or defaults.

import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test } from "vitest";

import { isServerManaged, serverManaged } from "./annotation";
import { STRICT_PARSE_OPTIONS } from "./definition";
import { deriveWriteShape } from "./write-schema";

const item = Schema.Struct({
  label: Schema.NonEmptyString,
  count: serverManaged(Schema.Number),
});
const entity = Schema.Struct({
  name: Schema.NonEmptyString,
  total: serverManaged(Schema.Number),
  optionalTotal: Schema.optionalKey(serverManaged(Schema.Number)),
  settings: Schema.optionalKey(item),
  items: Schema.Array(item),
  favorite: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});
const writes = deriveWriteShape(entity);
const decode = Schema.decodeUnknownSync(writes.schema, STRICT_PARSE_OPTIONS);

test("derives recursive create and update types and preserves defaults", () => {
  expectTypeOf<typeof writes.schema.Type>().toEqualTypeOf<{
    readonly name: string;
    readonly settings?: { readonly label: string };
    readonly items: ReadonlyArray<{ readonly label: string }>;
    readonly favorite: boolean;
  }>();
  expectTypeOf<typeof writes.schema.Encoded>().toEqualTypeOf<{
    readonly name: string;
    readonly settings?: { readonly label: string };
    readonly items: ReadonlyArray<{ readonly label: string }>;
    readonly favorite?: boolean | undefined;
  }>();
  expect(decode({ name: "Test", items: [{ label: "A" }] })).toEqual({
    name: "Test",
    items: [{ label: "A" }],
    favorite: false,
  });
  expect(() => decode({ name: "", items: [] })).toThrow();
  expect(() => decode({ name: "Test", items: [{ label: "" }] })).toThrow();
});

test("rejects managed input at every depth, including optional annotations", () => {
  const base = { name: "Test", items: [] };
  for (const input of [
    { ...base, total: 1 },
    { ...base, optionalTotal: 1 },
    { ...base, settings: { label: "A", count: 1 } },
    { ...base, items: [{ label: "A", count: 1 }] },
  ])
    expect(() => decode(input)).toThrow();
});

test("projects a parsed read value without mutating its managed data", () => {
  const read = {
    name: "Test",
    total: 4,
    settings: { label: "S", count: 3 },
    items: [{ label: "A", count: 1 }],
    favorite: true,
  };
  const original = structuredClone(read);
  expect(writes.project(read)).toEqual({
    name: "Test",
    settings: { label: "S" },
    items: [{ label: "A" }],
    favorite: true,
  });
  expect(read).toEqual(original);
});

test("preserves leaf and container constraints in the writable schema", () => {
  const shape = deriveWriteShape(
    Schema.Struct({
      name: Schema.NonEmptyString.check(Schema.isMaxLength(5)),
      amount: Schema.Int.check(Schema.isGreaterThan(0)),
      tags: Schema.Array(Schema.NonEmptyString).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(2),
      ),
      range: Schema.Struct({ start: Schema.Number, end: Schema.Number }).check(
        Schema.makeFilter((value) => value.start <= value.end),
      ),
    }),
  );
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  const valid = {
    name: "Valid",
    amount: 1,
    tags: ["a"],
    range: { start: 1, end: 2 },
  };
  for (const invalid of [
    { ...valid, name: "" },
    { ...valid, name: "Too long" },
    { ...valid, amount: -1 },
    { ...valid, amount: 1.5 },
    { ...valid, tags: [] },
    { ...valid, tags: [""] },
    { ...valid, tags: ["a", "b", "c"] },
    { ...valid, range: { start: 3, end: 2 } },
    { ...valid, name: 1 },
    { ...valid, amount: "1" },
    { ...valid, tags: {} },
  ]) {
    expect(() => parse(invalid)).toThrow();
  }
  expect(parse(valid)).toEqual(valid);
});

test("preserves non-empty arrays and their writable element constraints", () => {
  const shape = deriveWriteShape(
    Schema.Struct({ items: Schema.NonEmptyArray(item) }),
  );
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  expect(() => parse({ items: [] })).toThrow();
  expect(() => parse({ items: [{ label: "" }] })).toThrow();
  expect(parse({ items: [{ label: "Final" }] })).toEqual({
    items: [{ label: "Final" }],
  });
});

test("handles discriminated unions and record values", () => {
  const schema = Schema.Struct({
    choice: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        label: Schema.String,
        count: serverManaged(Schema.Number),
      }),
      Schema.Struct({
        kind: Schema.Literal("b"),
        enabled: Schema.Boolean,
        count: serverManaged(Schema.Number),
      }),
    ]),
    records: Schema.Record(Schema.String, item),
  });
  const shape = deriveWriteShape(schema);
  expectTypeOf<typeof shape.schema.Type>().toEqualTypeOf<{
    readonly choice:
      | { readonly kind: "a"; readonly label: string }
      | { readonly kind: "b"; readonly enabled: boolean };
    readonly records: { readonly [key: string]: { readonly label: string } };
  }>();
  const input = {
    choice: { kind: "b", enabled: true },
    records: { one: { label: "A" } },
  };
  expect(
    Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS)(input),
  ).toEqual(input);
  expect(
    shape.project({
      choice: { kind: "b", enabled: true, count: 5 },
      records: { one: { label: "A", count: 2 } },
    }),
  ).toEqual(input);
  expect(() =>
    Schema.decodeUnknownSync(
      shape.schema,
      STRICT_PARSE_OPTIONS,
    )({
      ...input,
      records: { one: { label: "A", count: 2 } },
    }),
  ).toThrow();
});

test("an object whose fields are all managed accepts exactly an empty object", () => {
  const shape = deriveWriteShape(
    Schema.Struct({ count: serverManaged(Schema.Number) }),
  );
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  expectTypeOf<typeof shape.schema.Type>().toEqualTypeOf<
    Readonly<Record<PropertyKey, never>>
  >();
  expectTypeOf<typeof shape.schema.Encoded>().toEqualTypeOf<
    typeof shape.schema.Type
  >();
  expect(parse({})).toEqual({});
  for (const input of [{ count: 2 }, "text", [], 1, null]) {
    expect(() => parse(input)).toThrow();
  }
});

test("retains exact empty writable types inside collections", () => {
  const shape = deriveWriteShape(
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({ count: serverManaged(Schema.Number) }),
      ),
    }),
  );
  const partial = { items: [{ count: 1 }] };
  expectTypeOf<typeof partial>().not.toExtend<typeof shape.schema.Type>();
  expectTypeOf<typeof partial>().not.toExtend<typeof shape.schema.Encoded>();
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  expect(parse({ items: [{}] })).toEqual({ items: [{}] });
  expect(() => parse(partial)).toThrow();
});

test("annotations survive additional checks and tuple element projection keeps its type", () => {
  const marked = serverManaged(Schema.Number).check(Schema.isGreaterThan(0));
  expect(isServerManaged(marked)).toBe(true);
  const schema = Schema.Struct({
    total: marked,
    pair: Schema.Tuple([item, Schema.String]),
    items: Schema.NonEmptyArray(item),
  });
  const shape = deriveWriteShape(schema);
  expectTypeOf<typeof shape.schema.Type.pair>().toEqualTypeOf<
    readonly [{ readonly label: string }, string]
  >();
  expectTypeOf<(typeof shape.schema.Type.items)[number]>().toEqualTypeOf<{
    readonly label: string;
  }>();
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  expect(
    parse({ pair: [{ label: "A" }, "B"], items: [{ label: "C" }] }),
  ).toEqual({
    pair: [{ label: "A" }, "B"],
    items: [{ label: "C" }],
  });
  expect(() =>
    parse({ total: 1, pair: [{ label: "A" }, "B"], items: [{ label: "C" }] }),
  ).toThrow();
});

test("rejects full-container codecs or checks that cannot be applied to a smaller shape", () => {
  expect(() =>
    deriveWriteShape(item.check(Schema.makeFilter((value) => value.count > 0))),
  ).toThrow("Containers with serverManaged");
  expect(() =>
    deriveWriteShape(
      item.pipe(
        Schema.withDecodingDefault(Effect.succeed({ label: "A", count: 1 })),
      ),
    ),
  ).toThrow("Containers with serverManaged");
});

type Node = {
  readonly label: string;
  readonly count: number;
  readonly children: ReadonlyArray<Node>;
};
const Node: Schema.Codec<Node> = Schema.Struct({
  label: Schema.NonEmptyString,
  count: serverManaged(Schema.Number),
  children: Schema.Array(Schema.suspend(() => Node)),
});

test("recursive schemas omit managed fields at every depth", () => {
  const shape = deriveWriteShape(Schema.Struct({ root: Node }));
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  const tree = {
    root: {
      label: "A",
      children: [{ label: "B", children: [{ label: "C", children: [] }] }],
    },
  };
  expect(parse(tree)).toEqual(tree);
  expect(() =>
    parse({
      root: {
        label: "A",
        children: [{ label: "B", children: [{ label: "", children: [] }] }],
      },
    }),
  ).toThrow();
  expect(() =>
    parse({
      root: {
        label: "A",
        children: [
          { label: "B", children: [{ label: "C", count: 1, children: [] }] },
        ],
      },
    }),
  ).toThrow();
  expect(
    shape.project({
      root: {
        label: "A",
        count: 1,
        children: [
          {
            label: "B",
            count: 2,
            children: [{ label: "C", count: 3, children: [] }],
          },
        ],
      },
    }),
  ).toEqual(tree);
});

test("recursion without managed fields keeps its schema, defaults, and checks", () => {
  type Plain = {
    readonly label: string;
    readonly children: ReadonlyArray<Plain>;
  };
  type PlainEncoded = {
    readonly label: string;
    readonly children?: ReadonlyArray<PlainEncoded>;
  };
  const Plain: Schema.Codec<Plain, PlainEncoded> = Schema.Struct({
    label: Schema.NonEmptyString,
    children: Schema.Array(Schema.suspend(() => Plain))
      .check(Schema.isMaxLength(2))
      .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  });
  const schema = Schema.Struct({ root: Plain });
  const shape = deriveWriteShape(schema);
  expect(shape.schema.ast).toBe(schema.ast);
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  expect(parse({ root: { label: "A", children: [{ label: "B" }] } })).toEqual({
    root: { label: "A", children: [{ label: "B", children: [] }] },
  });
  expect(() =>
    parse({
      root: {
        label: "A",
        children: [{ label: "B", children: [{}, {}, {}] }],
      },
    }),
  ).toThrow();
});

test("mutually recursive schemas derive one closed cycle", () => {
  type Group = {
    readonly name: string;
    readonly revision: number;
    readonly entries: ReadonlyArray<Entry>;
  };
  type Entry = {
    readonly label: string;
    readonly revision: number;
    readonly group?: Group;
  };
  const Group: Schema.Codec<Group> = Schema.Struct({
    name: Schema.String,
    revision: serverManaged(Schema.Number),
    entries: Schema.Array(Schema.suspend(() => Entry)),
  });
  const Entry: Schema.Codec<Entry> = Schema.Struct({
    label: Schema.String,
    revision: serverManaged(Schema.Number),
    group: Schema.optionalKey(Schema.suspend(() => Group)),
  });
  const shape = deriveWriteShape(Schema.Struct({ root: Group }));
  const parse = Schema.decodeUnknownSync(shape.schema, STRICT_PARSE_OPTIONS);
  const value = {
    root: {
      name: "A",
      entries: [
        { label: "a", group: { name: "B", entries: [{ label: "b" }] } },
      ],
    },
  };
  expect(parse(value)).toEqual(value);
  expect(() =>
    parse({
      root: {
        name: "A",
        entries: [
          { label: "a", group: { name: "B", revision: 1, entries: [] } },
        ],
      },
    }),
  ).toThrow();
});

test("rejects recursive containers that cannot follow the smaller shape when derived", () => {
  type Checked = {
    readonly count: number;
    readonly children: ReadonlyArray<Checked>;
  };
  const Checked: Schema.Codec<Checked> = Schema.Struct({
    count: serverManaged(Schema.Number),
    children: Schema.Array(Schema.suspend(() => Checked)),
  }).check(Schema.makeFilter((value) => value.count > 0));
  // The invalid container is reachable only through the suspension.
  expect(() =>
    deriveWriteShape(
      Schema.Struct({ roots: Schema.Array(Schema.suspend(() => Checked)) }),
    ),
  ).toThrow("Containers with serverManaged");
});
