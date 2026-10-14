// Purpose: Locks the JSON Patch boundary: strict operations, guarded pointers, and typed application failures.

import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { STRICT_PARSE_OPTIONS } from "./definition";
import { PatchRejected } from "./errors";
import {
  Patch,
  type PatchOperation,
  applyJsonPatch,
  pointerSegments,
} from "./patch";

const parse = Schema.decodeUnknownSync(Patch, STRICT_PARSE_OPTIONS);

describe("pointerSegments", () => {
  test("unescapes RFC 6901 segments", () => {
    expect(pointerSegments("/a~1b/0/~0x")).toEqual(["a/b", "0", "~x"]);
  });
});

describe("Patch schema", () => {
  test("accepts every RFC 6902 operation", () => {
    const operations = parse([
      {
        op: "add",
        path: "/widgets/-",
        value: { id: "wdg_1", kind: "watchlist" },
      },
      { op: "remove", path: "/widgets/0" },
      { op: "replace", path: "/name", value: "Rates" },
      { op: "move", from: "/widgets/0", path: "/widgets/1" },
      { op: "copy", from: "/name", path: "/title" },
      { op: "test", path: "/favorite", value: true },
    ]);
    expect(operations).toHaveLength(6);
  });

  test("rejects an empty patch, an unknown op, and a root pointer", () => {
    expect(() => parse([])).toThrow();
    expect(() => parse([{ op: "upsert", path: "/name", value: 1 }])).toThrow();
    expect(() => parse([{ op: "remove", path: "" }])).toThrow();
  });

  test.each(["add", "replace", "test"])("%s requires a JSON value", (op) => {
    for (const value of [
      null,
      true,
      1,
      "text",
      [],
      { nested: [1, false, null] },
    ]) {
      expect(parse([{ op, path: "/value", value }])).toEqual([
        { op, path: "/value", value },
      ]);
    }
    expect(() => parse([{ op, path: "/value" }])).toThrow();
    for (const value of [
      undefined,
      () => 1,
      1n,
      new Date(0),
      NaN,
      Infinity,
      { nested: undefined },
      [undefined],
    ]) {
      expect(() => parse([{ op, path: "/value", value }])).toThrow();
    }
  });

  test("rejects extra operation fields", () => {
    expect(() => parse([{ op: "remove", path: "/name", value: 1 }])).toThrow();
  });

  test.each(["", "name", "/bad~", "/bad~2", "/safe/__proto__/key"])(
    "rejects invalid path and from pointers: %s",
    (pointer) => {
      expect(() => parse([{ op: "remove", path: pointer }])).toThrow();
      for (const op of ["move", "copy"]) {
        expect(() => parse([{ op, from: pointer, path: "/name" }])).toThrow();
      }
    },
  );

  test("makes prototype-machinery pointers unrepresentable", () => {
    for (const segment of ["__proto__", "constructor", "prototype"]) {
      expect(() =>
        parse([{ op: "add", path: `/${segment}/polluted`, value: true }]),
      ).toThrow();
      for (const op of ["move", "copy"]) {
        expect(() =>
          parse([{ op, from: `/${segment}/polluted`, path: "/name" }]),
        ).toThrow();
      }
    }
  });
});

describe("applyJsonPatch", () => {
  test("returns the patched document and leaves the input untouched", () => {
    const document = { name: "Macro", widgets: [] };
    const next = Effect.runSync(
      applyJsonPatch(
        document,
        parse([
          { op: "replace", path: "/name", value: "Rates" },
          {
            op: "add",
            path: "/widgets/-",
            value: { id: "wdg_1", kind: "news" },
          },
        ]),
      ),
    );
    expect(next).toEqual({
      name: "Rates",
      widgets: [{ id: "wdg_1", kind: "news" }],
    });
    expect(document).toEqual({ name: "Macro", widgets: [] });
  });

  test("applies all six operations in order, including array moves", () => {
    const next = Effect.runSync(
      applyJsonPatch(
        { name: "Macro", widgets: ["first", "second"] },
        parse([
          { op: "test", path: "/name", value: "Macro" },
          { op: "replace", path: "/name", value: "Rates" },
          { op: "add", path: "/widgets/-", value: "third" },
          { op: "move", from: "/widgets/0", path: "/widgets/2" },
          { op: "copy", from: "/widgets/1", path: "/widgets/0" },
          { op: "remove", path: "/widgets/2" },
        ]),
      ),
    );
    expect(next).toEqual({
      name: "Rates",
      widgets: ["third", "second", "first"],
    });
  });

  test("applies escaped pointer segments", () => {
    const next = Effect.runSync(
      applyJsonPatch(
        { "a/b": { "~key": 1 } },
        parse([{ op: "replace", path: "/a~1b/~0key", value: 2 }]),
      ),
    );
    expect(next).toEqual({ "a/b": { "~key": 2 } });
  });

  test.each(["add", "replace"])(
    "%s isolates shared input values and can be rerun",
    (op) => {
      const shared = { x: 1 };
      const document = { original: shared, nested: { x: 0 } };
      const operations = parse([
        { op, path: "/nested", value: shared },
        { op: "replace", path: "/nested/x", value: 2 },
      ]);
      const before = structuredClone({ document, operations });
      const program = applyJsonPatch(document, operations);

      for (let run = 0; run < 2; run++) {
        expect(Effect.runSync(program)).toEqual({
          original: { x: 1 },
          nested: { x: 2 },
        });
        expect({ document, operations }).toEqual(before);
      }
    },
  );

  test("one operation cannot change a later operation sharing its value", () => {
    const shared = { x: 1 };
    const next = Effect.runSync(
      applyJsonPatch(
        {},
        parse([
          { op: "add", path: "/first", value: shared },
          { op: "replace", path: "/first/x", value: 2 },
          { op: "add", path: "/second", value: shared },
        ]),
      ),
    );
    expect(next).toEqual({ first: { x: 2 }, second: { x: 1 } });
    expect(shared).toEqual({ x: 1 });
  });

  test.each([
    {
      operation: { op: "add", path: "/widgets/1", value: "news" },
      reason: "OPERATION_VALUE_OUT_OF_BOUNDS",
    },
    {
      operation: { op: "remove", path: "/missing" },
      reason: "OPERATION_PATH_UNRESOLVABLE",
    },
    {
      operation: { op: "replace", path: "/missing", value: 1 },
      reason: "OPERATION_PATH_UNRESOLVABLE",
    },
    {
      operation: { op: "move", from: "/missing", path: "/name" },
      reason: "OPERATION_FROM_UNRESOLVABLE",
    },
    {
      operation: { op: "copy", from: "/missing", path: "/name" },
      reason: "OPERATION_FROM_UNRESOLVABLE",
    },
    {
      operation: { op: "test", path: "/name", value: "Rates" },
      reason: "TEST_OPERATION_FAILED",
    },
  ] satisfies { operation: PatchOperation; reason: string }[])(
    "$operation.op failure identifies the operation and leaves inputs untouched",
    ({ operation, reason }) => {
      const document = { name: "Macro", widgets: [] };
      const operations = parse([
        { op: "add", path: "/nested", value: { x: 1 } },
        { op: "replace", path: "/nested/x", value: 2 },
        operation,
      ]);
      const before = structuredClone({ document, operations });
      const rejected = Effect.runSync(
        Effect.flip(applyJsonPatch(document, operations)),
      );

      expect(rejected).toBeInstanceOf(PatchRejected);
      expect(rejected).toMatchObject({
        index: 2,
        op: operation.op,
        path: operation.path,
        reason,
      });
      expect({ document, operations }).toEqual(before);
    },
  );

  test("identifies the failing occurrence of a reused operation object", () => {
    const operation = { op: "remove", path: "/name" } as const;
    const rejected = Effect.runSync(
      Effect.flip(applyJsonPatch({ name: "Macro" }, [operation, operation])),
    );
    expect(rejected).toMatchObject({ index: 1, op: "remove", path: "/name" });
  });

  test("unexpected exceptions remain defects", () => {
    const defect = new Error("document getter failed");
    const document = {
      get name(): never {
        throw defect;
      },
    };
    const exit = Effect.runSyncExit(
      applyJsonPatch(document, parse([{ op: "remove", path: "/name" }])),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  });
});
