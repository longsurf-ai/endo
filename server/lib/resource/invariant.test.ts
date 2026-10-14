// Purpose: Verifies typed invariant paths, safe writable projection, and structured schema diagnostics.

import { defineId } from "@openchart/identifier";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { expect, expectTypeOf, test, vi } from "vitest";

import { serverManaged } from "./annotation";
import { defineResource, STRICT_PARSE_OPTIONS } from "./definition";
import { envelopeFields } from "./envelope";
import {
  withInvariants,
  resourceIssues,
  type InvariantContext,
  type Path,
} from "./invariant";
import { deriveWriteShape } from "./write-schema";

const fields = Schema.Struct({
  ...envelopeFields(defineId("example", "Example.ID")),
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      count: serverManaged(Schema.Number),
    }),
  ),
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
const observed: Array<unknown> = [];
const entity = withInvariants(fields, (invariant) => [
  invariant(
    "Exactly one item",
    (value, { expect }) => {
      observed.push(value);
      expect(value.items, { path: ["items"] }).toHaveLength(1);
    },
    { code: "example.item_count" },
  ),
  invariant(
    "Names must be unique",
    (value, { expect }) => {
      const names = new Set<string>();
      value.items.forEach((item, index) => {
        expect(names.has(item.name), { path: ["items", index, "name"] }).toBe(
          false,
        );
        names.add(item.name);
      });
    },
    { code: "example.unique_names" },
  ),
]);
const unused = () => {
  throw new Error("Store must not run in schema tests");
};
const resource = defineResource({
  name: "example",
  entity,
  store: {
    load: unused,
    list: unused,
    insert: unused,
    save: unused,
    remove: unused,
  },
});
const envelope = {
  id: "example_test",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
};

function issues(schema: Schema.Codec<unknown>, value: unknown) {
  const result = Schema.decodeUnknownResult(
    schema,
    STRICT_PARSE_OPTIONS,
  )(value);
  if (Result.isSuccess(result)) throw new Error("Expected a schema failure");
  return resourceIssues(result.failure.issue);
}

test("paths validate fields, arrays, tuples, unions, records and branded leaves", () => {
  type Value = {
    cells: ReadonlyArray<{
      panes: ReadonlyArray<{ id: typeof fields.fields.id.Type }>;
    }>;
    pair: readonly [string, { name: string }];
    source:
      | { kind: "market"; listing: number }
      | { kind: "indicator"; output: string };
    slots: Record<string, { name: string }>;
    optional?: { name: string };
  };
  expectTypeOf<readonly ["cells", number, "panes", number, "id"]>().toExtend<
    Path<Value>
  >();
  expectTypeOf<readonly ["pair", 1, "name"]>().toExtend<Path<Value>>();
  expectTypeOf<readonly ["source", "output"]>().toExtend<Path<Value>>();
  expectTypeOf<readonly ["slots", "custom", "name"]>().toExtend<Path<Value>>();
  expectTypeOf<readonly ["optional", "name"]>().toExtend<Path<Value>>();
  expectTypeOf<readonly []>().toExtend<Path<Value>>();
  expectTypeOf<readonly ["cells", number, "paens"]>().not.toExtend<
    Path<Value>
  >();
  expectTypeOf<readonly ["cells", "panes"]>().not.toExtend<Path<Value>>();
  expectTypeOf<readonly ["cells", "0", "panes"]>().not.toExtend<Path<Value>>();
  expectTypeOf<
    readonly ["cells", number, "panes", number, "id", "length"]
  >().not.toExtend<Path<Value>>();
  expectTypeOf<readonly ["pair", 2]>().not.toExtend<Path<Value>>();
  expectTypeOf<readonly ["pair", 0, "name"]>().not.toExtend<Path<Value>>();
});

test("paths terminate for recursive JSON arrays embedded in prompts", () => {
  type Value = { name: string; prompt: { args: Schema.Json } };
  expectTypeOf<readonly ["name"]>().toExtend<Path<Value>>();
  expectTypeOf<readonly ["prompt", "args", number, number]>().toExtend<
    Path<Value>
  >();
  expectTypeOf<readonly ["naem"]>().not.toExtend<Path<Value>>();
});

test("the actual declaration infers paths and hides managed fields", () => {
  withInvariants(fields, (invariant) => [
    invariant(
      "Type checks",
      (value, { expect }) => {
        expectTypeOf<keyof typeof value>().toEqualTypeOf<"items" | "enabled">();
        expectTypeOf<
          keyof (typeof value.items)[number]
        >().toEqualTypeOf<"name">();
        expect(value.items, { path: ["items"] }).toHaveLength(1);
        // @ts-expect-error Managed envelope fields cannot be diagnostic paths.
        expect(true, { path: ["revision"] }).toBe(true);
        // @ts-expect-error Nested managed fields cannot be diagnostic paths.
        expect(true, { path: ["items", 0, "count"] }).toBe(true);
        // @ts-expect-error Misspelled fields fail at the call site.
        expect(true, { path: ["items", 0, "naem"] }).toBe(true);
        // @ts-expect-error Arrays require numeric indices.
        expect(true, { path: ["items", "0", "name"] }).toBe(true);
        // @ts-expect-error A boolean has no length matcher.
        expect(true, { path: ["enabled"] }).toHaveLength(1);
      },
      { code: "example.types" },
    ),
    // @ts-expect-error Async callbacks would outlive the synchronous parse.
    invariant("Async forbidden", async () => {}, { code: "example.async" }),
  ]);
});

test("full entity, body, create, update and encode share the same rules and defaults", () => {
  const writable = { items: [{ name: "a" }], enabled: true };
  const body = { items: [{ name: "a", count: 12 }] };
  const full = { ...envelope, ...body };
  observed.length = 0;
  const parsed = Schema.decodeUnknownSync(entity)(full);
  Schema.encodeSync(entity)(parsed);
  Schema.decodeUnknownSync(resource.body)(body);
  Schema.decodeUnknownSync(resource.createSchema)({ items: writable.items });
  Schema.decodeUnknownSync(resource.updateSchema)(writable);
  expect(observed).toEqual(Array.from({ length: 5 }, () => writable));
  for (const [schema, value] of [
    [entity, { ...envelope, items: [] }],
    [resource.body, { items: [] }],
    [resource.createSchema, { items: [] }],
    [resource.updateSchema, { items: [] }],
  ] as const) {
    expect(issues(schema, value)).toMatchObject([
      { code: "example.item_count", path: "/items", expected: 1, actual: 0 },
    ]);
  }
  expect(resource.entity).toBe(entity);
});

test("collects all failures across assertions and rules without rerunning callbacks", () => {
  observed.length = 0;
  expect(
    issues(resource.createSchema, {
      items: [{ name: "a" }, { name: "a" }, { name: "a" }],
    }),
  ).toEqual([
    {
      code: "example.item_count",
      path: "/items",
      actual: 3,
      expected: 1,
      message: "Exactly one item. Expected length 1; received 3.",
    },
    {
      code: "example.unique_names",
      path: "/items/1/name",
      actual: true,
      expected: false,
      message: "Names must be unique. Expected false; received true.",
    },
    {
      code: "example.unique_names",
      path: "/items/2/name",
      actual: true,
      expected: false,
      message: "Names must be unique. Expected false; received true.",
    },
  ]);
  expect(observed).toHaveLength(1);
});

test("preserves enclosing paths, JSON Pointer escaping, and root errors", () => {
  const nested = withInvariants(
    Schema.Struct({ "a/b~c": Schema.String }),
    (invariant) => [
      invariant(
        "Empty name",
        (value, { expect }) => {
          expect(value["a/b~c"], { path: ["a/b~c"] }).toHaveLength(0);
          expect(false, { path: [] }).toBe(true);
        },
        { code: "example.name" },
      ),
    ],
  );
  expect(
    issues(Schema.Struct({ nested: Schema.Array(nested) }), {
      nested: [{ "a/b~c": "x" }],
    }).map((issue) => issue.path),
  ).toEqual(["/nested/0/a~1b~0c", "/nested/0"]);
  expect(issues(nested, { "a/b~c": "x" }).map((issue) => issue.path)).toEqual([
    "/a~1b~0c",
    "",
  ]);
});

test("rebinds nested managed unions and records to the actual read or write shape", () => {
  const shape = Schema.Struct({
    ...envelopeFields(defineId("union", "Union.ID")),
    source: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        name: Schema.String,
        count: serverManaged(Schema.Number),
      }),
      Schema.Struct({
        kind: Schema.Literal("b"),
        label: Schema.String,
        total: serverManaged(Schema.Number),
      }),
    ]),
    slots: Schema.Record(
      Schema.String,
      Schema.Struct({
        name: Schema.String,
        count: serverManaged(Schema.Number),
      }),
    ),
  });
  const seen = vi.fn();
  const checked = withInvariants(shape, (invariant) => [
    invariant(
      "Observe writable data",
      (value) => {
        seen(value);
      },
      { code: "example.observe" },
    ),
  ]);
  const writes = deriveWriteShape(checked);
  const writable = {
    source: { kind: "b", label: "B" },
    slots: { one: { name: "One" } },
  };
  Schema.decodeUnknownSync(checked)({
    ...envelope,
    id: "union_test",
    source: { ...writable.source, total: 4 },
    slots: { one: { name: "One", count: 5 } },
  });
  Schema.decodeUnknownSync(writes.schema)(writable);
  expect(seen.mock.calls).toEqual([[writable], [writable]]);
});

test("unregistered full-container checks remain forbidden and rule exceptions remain defects", () => {
  expect(() =>
    deriveWriteShape(
      fields.check(Schema.makeFilter((value) => value.revision > 0)),
    ),
  ).toThrow("Containers with serverManaged descendants");
  const defect = new Error("Broken rule implementation");
  const broken = withInvariants(fields, (invariant) => [
    invariant(
      "Broken rule",
      () => {
        throw defect;
      },
      { code: "example.broken" },
    ),
  ]);
  const exit = Effect.runSync(
    Effect.exit(
      Schema.decodeUnknownEffect(deriveWriteShape(broken).schema)({
        items: [],
      }),
    ),
  );
  if (Exit.isSuccess(exit)) throw new Error("Expected a rule defect");
  expect(Cause.findDefect(exit.cause)).toEqual(Result.succeed(defect));
  expect(Cause.hasFails(exit.cause)).toBe(false);
  expect(() =>
    withInvariants(fields, (invariant) => [
      invariant("First", () => {}, { code: "example.duplicate" }),
      invariant("Second", () => {}, { code: "example.duplicate" }),
    ]),
  ).toThrow("codes must be unique");
});

test("structural failures retain useful messages and prevent business rule execution", () => {
  observed.length = 0;
  expect(issues(resource.createSchema, { items: [{ name: 2 }] })).toMatchObject(
    [
      {
        code: "schema.invalid",
        path: "/items/0/name",
        message: expect.stringContaining("string"),
      },
    ],
  );
  expect(observed).toEqual([]);
  expect(issues(Schema.NonEmptyString, "")).toMatchObject([
    {
      code: "schema.invalid",
      path: "",
      message: expect.stringContaining("length"),
    },
  ]);
});

test("nested writable invariants survive projection", () => {
  const child = withInvariants(
    Schema.Struct({
      name: Schema.String,
      count: serverManaged(Schema.Number),
    }),
    (invariant) => [
      invariant(
        "One character",
        (value, { expect }) => {
          expectTypeOf<keyof typeof value>().toEqualTypeOf<"name">();
          expect(value.name, { path: ["name"] }).toHaveLength(1);
        },
        { code: "example.child_name" },
      ),
    ],
  );
  const parent = Schema.Struct({
    ...envelopeFields(defineId("parent", "Parent.ID")),
    children: Schema.Array(child),
  });
  const writes = deriveWriteShape(parent);
  expect(issues(writes.schema, { children: [{ name: "long" }] })).toMatchObject(
    [
      {
        code: "example.child_name",
        path: "/children/0/name",
        actual: 4,
        expected: 1,
      },
    ],
  );
});

test("schema annotations and filter groups preserve registered invariant identity", () => {
  const filter = entity.ast.checks?.[0];
  if (!filter) throw new Error("Expected an invariant check");
  for (const annotated of [
    entity.annotate({ identifier: "Annotated" }),
    fields.check(Schema.makeFilterGroup([filter], { identifier: "Grouped" })),
  ]) {
    const writes = deriveWriteShape(annotated);
    expect(writes.schema.ast.checks?.[0]?.annotations?.identifier).toBe(
      annotated.ast.checks?.[0]?.annotations?.identifier,
    );
    expect(issues(writes.schema, { items: [] })).toMatchObject([
      { code: "example.item_count", path: "/items", actual: 0, expected: 1 },
    ]);
  }
});

type TreeNode = {
  readonly name: string;
  readonly count: number;
  readonly children: ReadonlyArray<TreeNode>;
};
const TreeNode: Schema.Codec<TreeNode> = Schema.Struct({
  name: Schema.String,
  count: serverManaged(Schema.Number),
  children: Schema.Array(Schema.suspend(() => TreeNode)),
});

test("recursive values type paths to their first repetition", () => {
  type Value = { readonly root: Omit<TreeNode, "count"> };
  expectTypeOf<readonly ["root", "children", number, "name"]>().toExtend<
    Path<Value>
  >();
  expectTypeOf<readonly ["root", "naem"]>().not.toExtend<Path<Value>>();
  expectTypeOf<readonly ["root", "children", "0"]>().not.toExtend<
    Path<Value>
  >();
});

test("scoped contexts walk recursive values and report whole-value pointers", () => {
  const tree = withInvariants(
    Schema.Struct({ ...fields.fields, root: TreeNode }),
    (invariant) => [
      invariant(
        "Names must be unique across the tree",
        (value, { at }) => {
          const names = new Set<string>();
          const visit = (
            node: typeof value.root,
            context: InvariantContext<typeof value.root>,
          ) => {
            context
              .expect(names.has(node.name), { path: ["name"] })
              .toBe(false);
            names.add(node.name);
            node.children.forEach((child, i) =>
              visit(child, context.at(["children", i])),
            );
          };
          visit(value.root, at(["root"]));
        },
        { code: "example.unique_tree_names" },
      ),
    ],
  );
  const root = {
    name: "A",
    count: 1,
    children: [
      {
        name: "B",
        count: 2,
        children: [{ name: "A", count: 3, children: [] }],
      },
    ],
  };
  expect(issues(tree, { ...envelope, items: [], root })).toEqual([
    expect.objectContaining({
      code: "example.unique_tree_names",
      path: "/root/children/0/children/0/name",
    }),
  ]);
  const writes = deriveWriteShape(tree);
  expect(
    issues(writes.schema, {
      items: [],
      root: {
        name: "A",
        children: [{ name: "A", children: [] }],
      },
    }),
  ).toEqual([
    expect.objectContaining({
      code: "example.unique_tree_names",
      path: "/root/children/0/name",
    }),
  ]);
});
