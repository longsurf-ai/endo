// Purpose: RFC 6902 JSON Patch boundary: strict operation schema, pointer guards, and the applier over fast-json-patch.

import { Effect, Schema } from "effect";
// The default export is the only surface shaped identically across loaders:
// the ESM shim drops fast-json-patch's `export *` names, while the CJS entry
// has no `default` of its own (Node interop synthesizes it as module.exports).
import fastJsonPatch from "fast-json-patch";

import { PatchRejected } from "./errors";

const { applyOperation, JsonPatchError } = fastJsonPatch;

// Pointers that could reach prototype machinery are unrepresentable at the
// schema, independent of the applier's own guards.
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const JSON_POINTER_PATTERN = /^(\/([^/~]|~0|~1)*)+$/;

/**
 * Splits an RFC 6901 pointer into its unescaped segments.
 *
 * @param pointer - A non-root JSON Pointer such as `/widgets/0/kind`.
 * @returns The decoded segments in order.
 *
 * @example
 * ```ts
 * pointerSegments('/a~1b/0'); // => ['a/b', '0']
 * ```
 */
export function pointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const JsonPointer = Schema.String.check(
  Schema.isPattern(JSON_POINTER_PATTERN, {
    description:
      "a non-root RFC 6901 JSON Pointer such as /name or /widgets/0/kind",
  }),
  Schema.makeFilter<string>(
    (pointer) =>
      pointerSegments(pointer).every(
        (segment) => !FORBIDDEN_SEGMENTS.has(segment),
      ),
    { description: "a pointer that never names prototype machinery" },
  ),
);

/**
 * One RFC 6902 operation. The union is strict: an unknown `op` or a pointer
 * outside the grammar fails to parse before the applier runs.
 */
export const PatchOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    path: JsonPointer,
    value: Schema.Json,
  }),
  Schema.Struct({ op: Schema.Literal("remove"), path: JsonPointer }),
  Schema.Struct({
    op: Schema.Literal("replace"),
    path: JsonPointer,
    value: Schema.Json,
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    from: JsonPointer,
    path: JsonPointer,
  }),
  Schema.Struct({
    op: Schema.Literal("copy"),
    from: JsonPointer,
    path: JsonPointer,
  }),
  Schema.Struct({
    op: Schema.Literal("test"),
    path: JsonPointer,
    value: Schema.Json,
  }),
]);

/** One RFC 6902 operation accepted by the default `patch` transition. */
export type PatchOperation = typeof PatchOperation.Type;

/** A non-empty, ordered list of operations applied atomically. */
export const Patch = Schema.NonEmptyArray(PatchOperation);

/** A non-empty, ordered list of operations applied atomically. */
export type Patch = typeof Patch.Type;

/**
 * Applies a patch to a document and returns the new document.
 *
 * The input document and operations are never mutated. An unresolvable
 * pointer, a failed `test`, or an out-of-bounds index fails with
 * {@link PatchRejected} naming the offending operation; nothing is partially
 * applied. Unexpected exceptions remain defects.
 *
 * @param document - The current JSON value.
 * @param operations - Parsed operations in application order.
 * @returns The patched document.
 *
 * @example
 * ```ts
 * const next = yield* applyJsonPatch({name: 'a'}, [
 *   {op: 'replace', path: '/name', value: 'b'},
 * ]);
 * ```
 */
export function applyJsonPatch(
  document: Schema.Json,
  operations: Patch,
): Effect.Effect<Schema.Json, PatchRejected> {
  return Effect.suspend(() => {
    let result: Schema.Json = structuredClone(document);
    for (const [index, operation] of operations.entries()) {
      try {
        // @agent invariant: The applier may mutate inserted values; each
        // operation needs its own clone, even when inputs share references.
        result = applyOperation(
          result,
          structuredClone(operation),
          true,
        ).newDocument;
      } catch (error) {
        if (!(error instanceof JsonPatchError)) return Effect.die(error);
        return Effect.fail(
          new PatchRejected({
            index,
            op: operation.op,
            path: operation.path,
            reason: error.name,
          }),
        );
      }
    }
    return Effect.succeed(result);
  });
}
