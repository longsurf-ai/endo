// Purpose: Proves invariant failures reach tRPC clients before writes and cannot hide corrupt stored state.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { defineId } from "@openchart/identifier";
import { makeRuntime } from "@openchart/server/runtime";
import { resourceRouter } from "@openchart/server/lib/trpc/resource-router";
import type { inferRouterInputs } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { ConfigProvider, Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";

import { serverManaged } from "./annotation";
import { defineResource } from "./definition";
import { envelopeFields } from "./envelope";
import { ResourceIssue, withInvariants } from "./invariant";
import type { Row, Store } from "./store";
import type { WritableSchema } from "./write-schema";

const entity = withInvariants(
  Schema.Struct({
    ...envelopeFields(defineId("example", "Example.ID")),
    name: Schema.String,
    items: Schema.Array(Schema.Struct({ name: Schema.String })),
    total: serverManaged(Schema.Number),
  }),
  (invariant) => [
    invariant(
      "Exactly one item",
      (value, { expect }) => {
        expect(value.items, { path: ["items"] }).toHaveLength(1);
      },
      { code: "example.item_count" },
    ),
    invariant(
      "Item name must match the resource name",
      (value, { expect }) => {
        value.items.forEach((item, index) => {
          expect(item.name, { path: ["items", index, "name"] }).toBe(
            value.name,
          );
        });
      },
      { code: "example.match_name" },
    ),
  ],
);
type Value = WritableSchema<typeof entity>["Type"];
let row: Row | undefined;
const insert = vi.fn<Store<Value>["insert"]>((_tx, input) =>
  Effect.sync(() => {
    row = {
      ...input,
      createdAt: 10,
      updatedAt: 10,
      body: { ...input.body, total: 1 },
    };
    return row;
  }),
);
const save = vi.fn<Store<Value>["save"]>((_tx, id, input) =>
  Effect.sync(() => {
    row = {
      id,
      ...input,
      createdAt: 10,
      updatedAt: 20,
      body: { ...input.body, total: 1 },
    };
    return row;
  }),
);
const resource = defineResource({
  name: "example",
  entity,
  store: {
    load: () => Effect.succeed(row),
    list: () => Effect.succeed(row ? [row] : []),
    insert,
    save,
    remove: () => Effect.void,
  },
});
const router = resourceRouter(resource);
let runtime: ReturnType<typeof makeRuntime>;
let caller: ReturnType<typeof router.createCaller>;
const input = { name: "A", items: [{ name: "A" }] };

beforeEach(() => {
  row = undefined;
  vi.clearAllMocks();
  runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  caller = router.createCaller({ runtime });
});
afterEach(async () => {
  await runtime.dispose();
});

const wireError = Schema.Struct({
  error: Schema.Struct({
    data: Schema.Struct({
      code: Schema.String,
      resourceStateInvalid: Schema.NullOr(
        Schema.Struct({
          resource: Schema.String,
          issues: Schema.Array(ResourceIssue),
        }),
      ),
    }),
  }),
});
async function request(action: "create" | "patch", value: unknown) {
  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    router,
    req: new Request(`http://localhost/trpc/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }),
    createContext: () => ({ runtime }),
  });
  return {
    status: response.status,
    ...Schema.decodeUnknownSync(wireError)(await response.json()),
  };
}

test("create exposes structured invariant failures in the HTTP response without inserting", async () => {
  const result = await request("create", {
    name: "A",
    items: [{ name: "B" }, { name: "C" }],
  });
  expect(result.status).toBe(400);
  expect(result.error.data).toMatchObject({
    code: "BAD_REQUEST",
    resourceStateInvalid: {
      resource: "example",
      issues: [
        { code: "example.item_count", path: "/items", expected: 1, actual: 2 },
        {
          code: "example.match_name",
          path: "/items/0/name",
          expected: "A",
          actual: "B",
        },
        {
          code: "example.match_name",
          path: "/items/1/name",
          expected: "A",
          actual: "C",
        },
      ],
    },
  });
  expect(insert).not.toHaveBeenCalled();
  expect(row).toBeUndefined();
});

test("patch exposes final candidate paths without saving or advancing revision", async () => {
  const created = await caller.create(input);
  const result = await request("patch", {
    id: created.id,
    expectedRevision: 1,
    operations: [{ op: "replace", path: "/items/0/name", value: "B" }],
  });
  expect(result.status).toBe(400);
  expect(result.error.data.resourceStateInvalid).toMatchObject({
    resource: "example",
    issues: [
      {
        code: "example.match_name",
        path: "/items/0/name",
        expected: "A",
        actual: "B",
      },
    ],
  });
  expect(save).not.toHaveBeenCalled();
  expect(row?.revision).toBe(1);
  expect(await caller.get({ id: created.id })).toEqual(created);
});

test("a multi-operation patch may temporarily break a cross-field invariant", async () => {
  const created = await caller.create(input);
  const changed = await caller.patch({
    id: created.id,
    expectedRevision: 1,
    operations: [
      { op: "replace", path: "/name", value: "B" },
      { op: "replace", path: "/items/0/name", value: "B" },
    ],
  });
  expect(changed).toMatchObject({
    name: "B",
    items: [{ name: "B" }],
    total: 1,
    revision: 2,
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]?.[2].body).toEqual({
    name: "B",
    items: [{ name: "B" }],
  });
});

test("structural input failures also have paths and never reach insert", async () => {
  const result = await request("create", { name: "A", items: [{ name: 123 }] });
  expect(result.error.data.resourceStateInvalid?.issues).toMatchObject([
    { code: "schema.invalid", path: "/items/0/name" },
  ]);
  expect(insert).not.toHaveBeenCalled();
});

test("create preserves encoded input types and awaits schema defaults", async () => {
  const defaulted = defineResource({
    name: "defaulted",
    entity: Schema.Struct({
      ...entity.fields,
      name: Schema.String.pipe(
        Schema.withDecodingDefault(Effect.succeed("A").pipe(Effect.delay(1))),
      ),
    }),
    store: resource.store,
  });
  const defaultedRouter = resourceRouter(defaulted);
  type Input = inferRouterInputs<typeof defaultedRouter>["create"];
  expectTypeOf<Input>().toEqualTypeOf<typeof defaulted.createSchema.Encoded>();
  const defaultedCaller = defaultedRouter.createCaller({
    runtime,
  });
  expect(
    await defaultedCaller.create({ items: [{ name: "A" }] }),
  ).toMatchObject({
    name: "A",
    items: [{ name: "A" }],
  });
  expect(insert).toHaveBeenCalledTimes(1);
});

test("exceptions while reading create input remain server errors", async () => {
  const defect = new Error("Broken input getter");
  await expect(
    caller.create({
      get name(): string {
        throw defect;
      },
      items: [],
    }),
  ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", cause: defect });
  expect(insert).not.toHaveBeenCalled();
});

test("invalid stored bodies stay defects on get, list and patch before saving", async () => {
  const created = await caller.create(input);
  row = { ...created, body: { name: "A", items: [], total: 1 } };
  for (const operation of [
    () => caller.get({ id: created.id }),
    () => caller.list(),
    () =>
      caller.patch({
        id: created.id,
        expectedRevision: 1,
        operations: [{ op: "replace", path: "/name", value: "B" }],
      }),
  ]) {
    await expect(operation()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  }
  expect(save).not.toHaveBeenCalled();
});

test("rule implementation exceptions remain server errors at create and patch boundaries", async () => {
  const defect = new Error("Broken business rule");
  const broken = withInvariants(Schema.Struct(entity.fields), (invariant) => [
    invariant(
      "A faulty rule",
      (value) => {
        if (value.name === "broken") throw defect;
      },
      { code: "example.broken" },
    ),
  ]);
  const brokenCaller = resourceRouter(
    defineResource({
      name: "broken",
      entity: broken,
      store: resource.store,
    }),
  ).createCaller({ runtime });
  await expect(
    brokenCaller.create({ name: "broken", items: [] }),
  ).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    cause: defect,
  });
  expect(insert).not.toHaveBeenCalled();
  const created = await brokenCaller.create(input);
  await expect(
    brokenCaller.patch({
      id: created.id,
      expectedRevision: 1,
      operations: [{ op: "replace", path: "/name", value: "broken" }],
    }),
  ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", cause: defect });
  expect(save).not.toHaveBeenCalled();
  expect(row?.revision).toBe(1);
});
