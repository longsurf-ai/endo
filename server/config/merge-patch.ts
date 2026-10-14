// Purpose: Derives strict Config patches and applies JSON Merge Patch without mutating inputs.

import { Predicate, Schema, SchemaAST } from "effect";

/** Optional object fields delete on null; arrays replace their entire value. */
export type MergePatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: MergePatch<T[K]> | null }
    : T;

/**
 * Applies an object-root RFC 7396 patch to an already parsed JSON document.
 * Null removes keys, nested objects merge, and other values replace. Neither
 * input is mutated; inherited properties never participate in the merge.
 *
 * @example
 * ```ts
 * mergePatch({appearance: {theme: 'dark'}}, {appearance: {theme: null}});
 * // {appearance: {}}
 * ```
 */
export function mergePatch(
  target: Schema.JsonObject,
  patch: Schema.JsonObject,
): Schema.JsonObject {
  const result = new Map(Object.entries(target));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) result.delete(key);
    else if (Predicate.isObject(value)) {
      const previous = result.get(key);
      result.set(
        key,
        mergePatch(
          Predicate.isObject(previous) ? (previous as Schema.JsonObject) : {},
          value as Schema.JsonObject,
        ),
      );
    } else result.set(key, value);
  }
  return Object.fromEntries(result);
}

function derive(ast: SchemaAST.AST, partial: boolean): SchemaAST.AST {
  switch (ast._tag) {
    case "Objects": {
      if (
        ast.indexSignatures.length ||
        !ast.propertySignatures.length ||
        ast.propertySignatures.some((field) => typeof field.name !== "string")
      ) {
        throw new Error("Config patches require nonempty string-key structs");
      }
      return new SchemaAST.Objects(
        ast.propertySignatures.map((field) => {
          const value = derive(field.type, partial);
          return new SchemaAST.PropertySignature(
            field.name,
            partial
              ? Schema.optionalKey(Schema.NullOr(Schema.make(value))).ast
              : value,
          );
        }),
        [],
        { ...ast.annotations, parseOptions: { onExcessProperty: "error" } },
        partial ? undefined : ast.checks,
        undefined,
        ast.context,
      );
    }
    case "Arrays":
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map((element) => derive(element, false)),
        ast.rest.map((element) => derive(element, false)),
        ast.annotations,
        ast.checks,
        undefined,
        ast.context,
      );
    case "Union": {
      const types = ast.types.filter(
        (type) => !(ast.context?.isOptional && type._tag === "Undefined"),
      );
      if (
        types.length > 1 &&
        types.some((type) => ["Objects", "Arrays"].includes(type._tag))
      ) {
        throw new Error("Config patches do not support unions of containers");
      }
      return new SchemaAST.Union(
        types.map((type) => derive(type, partial)),
        ast.mode,
        ast.annotations,
        ast.checks,
        undefined,
        ast.context,
      );
    }
    case "String":
    case "Number":
    case "Boolean":
    case "Enum":
      return ast;
    case "Literal":
      if (["string", "number", "boolean"].includes(typeof ast.literal)) {
        return ast;
      }
      throw new Error("Config patch literals must be JSON scalars");
    default:
      throw new Error(`Unsupported Config patch schema: ${ast._tag}`);
  }
}

/**
 * Derives a strict patch for JSON-native Config structs from their decoded
 * schema. Removes decoding defaults so an omitted field never becomes a write.
 * Scalar checks survive, and array elements remain complete replacement values.
 * Object-wide checks run against the merged domain in the Config write boundary.
 *
 * @throws For unsupported shapes such as records, recursive declarations,
 * or container unions.
 * @example
 * ```ts
 * const Patch = mergePatchSchema(Schema.Struct({enabled: Schema.Boolean}));
 * Schema.decodeUnknownSync(Patch)({enabled: null});
 * ```
 */
export function mergePatchSchema<S extends Schema.Top>(
  schema: S,
): Schema.Codec<MergePatch<S["Type"]>> {
  const ast = SchemaAST.toType(schema.ast);
  if (ast._tag !== "Objects") {
    throw new Error("Config patches require an object root");
  }
  return Schema.make(derive(ast, true));
}
