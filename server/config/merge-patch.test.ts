// Purpose: Verifies Config patch defaults, strict boundaries, and immutable merge semantics.

import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { mergePatch, mergePatchSchema } from "./merge-patch";

const Settings = Schema.Struct({
  appearance: Schema.Struct({
    theme: Schema.Literals(["light", "dark", "system"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("system")),
    ),
    scale: Schema.Number.check(Schema.isGreaterThan(0)).pipe(
      Schema.withDecodingDefault(Effect.succeed(1)),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  provider: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.Boolean, endpoint: Schema.String }),
  ),
  optional: Schema.optional(
    Schema.Struct({ value: Schema.optional(Schema.String) }),
  ),
  models: Schema.Array(Schema.Struct({ id: Schema.String })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
const Patch = mergePatchSchema(Settings);
const decode = Schema.decodeUnknownSync(Patch);

test("derives nested partials without materializing decoding defaults", () => {
  expect(decode({})).toEqual({});
  expect(decode({ appearance: {} })).toEqual({ appearance: {} });
  expect(decode({ provider: { enabled: true } })).toEqual({
    provider: { enabled: true },
  });
  expect(decode({ optional: {} })).toEqual({ optional: {} });
  expect(decode({ optional: { value: "set" } })).toEqual({
    optional: { value: "set" },
  });
  const document = mergePatch(
    { appearance: { theme: "dark", scale: 2 } },
    decode({ appearance: { theme: null } }),
  );
  expect(document).toEqual({ appearance: { scale: 2 } });
  expect(Schema.decodeUnknownSync(Settings)(document).appearance).toEqual({
    theme: "system",
    scale: 2,
  });
});

test.each([
  null,
  [],
  true,
  { typo: null },
  { appearance: { typo: null } },
  { appearance: { theme: "invalid" } },
  { appearance: { scale: 0 } },
  { provider: { enabled: "true" } },
  { optional: { value: undefined } },
  { models: [{ id: "model", typo: null }] },
  { models: [{}] },
  JSON.parse('{"__proto__":null}'),
  JSON.parse('{"appearance":{"constructor":null}}'),
])("rejects invalid patch input %#", (input) => {
  expect(() => decode(input)).toThrow();
});

test("merges nested fields, replaces arrays, and does not mutate either input", () => {
  const target = Object.freeze({
    appearance: Object.freeze({ theme: "dark", scale: 1 }),
    models: Object.freeze([{ id: "old" }]),
    untouched: Object.freeze({ value: 1 }),
  });
  const patch = Object.freeze({
    appearance: Object.freeze({ theme: null }),
    models: Object.freeze([{ id: "new" }]),
  });
  expect(mergePatch(target, patch)).toEqual({
    appearance: { scale: 1 },
    models: [{ id: "new" }],
    untouched: { value: 1 },
  });
  expect(target.appearance.theme).toBe("dark");
  expect(patch.appearance.theme).toBeNull();
  expect(
    mergePatch({ provider: false }, { provider: { enabled: true } }),
  ).toEqual({
    provider: { enabled: true },
  });
});

test("prototype-like keys remain ordinary own properties", () => {
  const patch = Schema.decodeUnknownSync(Schema.JsonObject)(
    JSON.parse('{"__proto__":{"polluted":true},"constructor":{"safe":true}}'),
  );
  const result = mergePatch({}, patch);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(result.__proto__).toEqual({ polluted: true });
  expect(result.constructor).toEqual({ safe: true });
  expect(Object.hasOwn({}, "polluted")).toBe(false);
});

test("unsupported schema shapes fail when constructing the patch contract", () => {
  for (const schema of [
    Schema.String,
    Schema.Struct({}),
    Schema.Struct({ values: Schema.Record(Schema.String, Schema.Boolean) }),
    Schema.Struct({ value: Schema.URL }),
    Schema.Struct({ value: Schema.Literal(1n) }),
  ]) {
    expect(() => mergePatchSchema(schema)).toThrow();
  }
});

test("object-wide constraints validate the merged domain, not an isolated partial", () => {
  const Provider = Schema.Struct({
    enabled: Schema.Boolean,
    modelIDs: Schema.Array(Schema.String),
  }).check(
    Schema.makeFilter((value) => !value.enabled || value.modelIDs.length > 0),
  );
  const decodePatch = Schema.decodeUnknownSync(mergePatchSchema(Provider));
  const patch = decodePatch({ enabled: true });
  expect(patch).toEqual({ enabled: true });
  expect(() =>
    Schema.decodeUnknownSync(Provider)(
      mergePatch({ enabled: false, modelIDs: [] }, patch),
    ),
  ).toThrow();
  expect(
    Schema.decodeUnknownSync(Provider)(
      mergePatch({ enabled: false, modelIDs: ["model"] }, patch),
    ),
  ).toEqual({ enabled: true, modelIDs: ["model"] });
});
