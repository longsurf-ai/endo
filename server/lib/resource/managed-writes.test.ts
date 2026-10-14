// Purpose: Verifies derived write schemas at the tRPC boundary and before store writes.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { defineId } from "@openchart/identifier";
import { makeRuntime } from "@openchart/server/runtime";
import { resourceRouter } from "@openchart/server/lib/trpc/resource-router";
import { ConfigProvider, Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { serverManaged } from "./annotation";
import { defineResource } from "./definition";
import { envelopeFields } from "./envelope";
import type { Patch } from "./patch";
import type { Row, Store, StoreBody } from "./store";
import * as Transition from "./transition";
import * as Transactor from "./transactor";

const entity = Schema.Struct({
  ...envelopeFields(defineId("example", "Example.ID")),
  name: Schema.NonEmptyString,
  total: serverManaged(Schema.Number),
  settings: Schema.Struct({
    label: Schema.String,
    count: serverManaged(Schema.Number),
  }),
  items: Schema.Array(
    Schema.Struct({ key: Schema.String, count: serverManaged(Schema.Number) }),
  ),
});
type Body = StoreBody<typeof entity>;
type FullBody = Omit<
  typeof entity.Type,
  "id" | "revision" | "createdAt" | "updatedAt"
>;

// Client writes preserve server-owned columns and keyed child rows; internal
// full-state writes can explicitly change the same managed values.
function persisted(value: Body, current?: FullBody): FullBody {
  if ("total" in value) return value;
  return {
    ...value,
    total: current?.total ?? 10,
    settings: { ...value.settings, count: current?.settings.count ?? 20 },
    items: value.items.map((item) => ({
      ...item,
      count:
        current?.items.find((existing) => existing.key === item.key)?.count ??
        (item.key === "a" ? 30 : 40),
    })),
  };
}
let row: Row<FullBody> | undefined;
const insert = vi.fn<Store<Body>["insert"]>((_tx, input) =>
  Effect.sync(() => {
    row = {
      ...input,
      createdAt: 100,
      updatedAt: 100,
      body: persisted(input.body),
    };
    return row;
  }),
);
const save = vi.fn<Store<Body>["save"]>((_tx, id, input) =>
  Effect.sync(() => {
    row = {
      id,
      revision: input.revision,
      createdAt: 100,
      updatedAt: 200,
      body: persisted(input.body, row?.body),
    };
    return row;
  }),
);
const store: Store<Body> = {
  load: () => Effect.succeed(row),
  list: () => Effect.succeed(row ? [row] : []),
  insert,
  save,
  remove: () => Effect.void,
};
const resource = defineResource({ name: "example", entity, store });
const router = resourceRouter(resource);
let runtime: ReturnType<typeof makeRuntime>;
let caller: ReturnType<typeof router.createCaller>;
const input = {
  name: "Example",
  settings: { label: "S" },
  items: [{ key: "a" }, { key: "b" }],
};

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

test("create omits managed inputs while returning the complete entity", async () => {
  const created = await caller.create(input);
  expect(created.total).toBe(10);
  expect(created.settings.count).toBe(20);
  expect(created.items.map((item) => item.count)).toEqual([30, 40]);
  expect(insert.mock.calls[0]?.[1].body).toEqual(input);
  expect(await caller.get({ id: created.id })).toEqual(created);
  for (const invalid of [
    { ...input, total: 1 },
    { ...input, settings: { label: "S", count: 1 } },
    { ...input, items: [{ key: "a", count: 1 }] },
  ])
    await expect(caller.create(invalid)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  expect(insert).toHaveBeenCalledTimes(1);
});

test("patch writes only mutable data and preserves server-owned values through parent replacement and reorder", async () => {
  const created = await caller.create(input);
  const patched = await caller.patch({
    id: created.id,
    expectedRevision: 1,
    operations: [
      { op: "replace", path: "/settings", value: { label: "Changed" } },
      { op: "move", from: "/items/0", path: "/items/1" },
    ],
  });
  expect(patched.revision).toBe(2);
  expect(patched.total).toBe(10);
  expect(patched.settings).toEqual({ label: "Changed", count: 20 });
  expect(patched.items).toEqual([
    { key: "b", count: 40 },
    { key: "a", count: 30 },
  ]);
  expect(save.mock.calls[0]?.[2].body).toEqual({
    name: "Example",
    settings: { label: "Changed" },
    items: [{ key: "b" }, { key: "a" }],
  });
});

test("internal transitions save managed fields that later client patches preserve by child identity", async () => {
  const created = await caller.create(input);
  const body = {
    ...input,
    total: 100,
    settings: { ...input.settings, count: 200 },
    items: [
      { key: "a", count: 300 },
      { key: "b", count: 400 },
    ],
  };
  await runtime.runPromise(
    Transactor.run(
      Transition.from((tx) =>
        store.save(tx, created.id, { body, revision: 2 }),
      ),
    ),
  );
  expect(await caller.get({ id: created.id })).toMatchObject(body);
  const patched = await caller.patch({
    id: created.id,
    expectedRevision: 2,
    operations: [
      { op: "replace", path: "/settings", value: { label: "Changed" } },
      { op: "move", from: "/items/0", path: "/items/1" },
    ],
  });
  expect(patched).toMatchObject({
    total: 100,
    settings: { label: "Changed", count: 200 },
    items: [
      { key: "b", count: 400 },
      { key: "a", count: 300 },
    ],
    revision: 3,
  });
});

test.each(
  (
    [
      [
        { op: "replace", path: "/name", value: "" },
        { op: "replace", path: "/name", value: "Final" },
      ],
      [
        { op: "remove", path: "/name" },
        { op: "add", path: "/name", value: "Final" },
      ],
      [
        { op: "replace", path: "/name", value: 123 },
        { op: "replace", path: "/name", value: "Final" },
      ],
      [
        { op: "add", path: "/scratch", value: { name: "Final" } },
        { op: "copy", from: "/scratch/name", path: "/name" },
        { op: "remove", path: "/scratch" },
      ],
      [
        { op: "add", path: "/total", value: 999 },
        { op: "add", path: "/items/0/count", value: 999 },
        { op: "remove", path: "/total" },
        { op: "remove", path: "/items/0/count" },
        { op: "replace", path: "/name", value: "Final" },
      ],
    ] satisfies Patch[]
  ).map((operations) => ({ operations })),
)(
  "validates and saves the complete patch result (%#)",
  async ({ operations }) => {
    const created = await caller.create(input);
    const patched = await caller.patch({
      id: created.id,
      expectedRevision: 1,
      operations,
    });
    expect(patched).toEqual({
      ...created,
      name: "Final",
      revision: 2,
      updatedAt: 200,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[2].body).toEqual({ ...input, name: "Final" });
    expect(await caller.get({ id: created.id })).toEqual(patched);
  },
);

test("rejects an invalid final value before saving", async () => {
  const created = await caller.create(input);
  await expect(
    caller.patch({
      id: created.id,
      expectedRevision: 1,
      operations: [{ op: "replace", path: "/name", value: "" }],
    }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    cause: { _tag: "Resource.StateInvalid" },
  });
  expect(save).not.toHaveBeenCalled();
  expect(await caller.get({ id: created.id })).toEqual(created);
});

test("rejects final values containing managed or undeclared fields before saving", async () => {
  const created = await caller.create(input);
  const patches: Patch[] = [
    [{ op: "add", path: "/total", value: 1 }],
    [{ op: "add", path: "/unknown", value: 1 }],
    [{ op: "add", path: "/settings/count", value: 1 }],
    [{ op: "replace", path: "/settings", value: { label: "S", count: 1 } }],
    [{ op: "replace", path: "/items", value: [{ key: "a", count: 1 }] }],
    [
      { op: "replace", path: "/name", value: "First" },
      { op: "add", path: "/items/0/count", value: 1 },
    ],
  ];
  for (const operations of patches) {
    await expect(
      caller.patch({ id: created.id, expectedRevision: 1, operations }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { _tag: "Resource.StateInvalid" },
    });
    expect(await caller.get({ id: created.id })).toEqual(created);
  }
  expect(save).not.toHaveBeenCalled();
});

test("patch cannot address stored managed fields absent from its projection", async () => {
  const created = await caller.create(input);
  const patches: Patch[] = [
    [{ op: "remove", path: "/total" }],
    [{ op: "replace", path: "/settings/count", value: 1 }],
    [{ op: "copy", from: "/total", path: "/name" }],
    [{ op: "move", from: "/settings/count", path: "/total" }],
    [{ op: "test", path: "/total", value: 10 }],
  ];
  for (const operations of patches) {
    await expect(
      caller.patch({ id: created.id, expectedRevision: 1, operations }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", cause: { index: 0 } });
  }
  expect(save).not.toHaveBeenCalled();
  expect(await caller.get({ id: created.id })).toEqual(created);
});
