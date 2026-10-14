// Purpose: Derives optional scalar list filters from entity field annotations.

import { Schema, SchemaAST } from "effect";

import { isListKey, LIST_KEY } from "./annotation";

type Marked<S> = S extends { readonly [LIST_KEY]: true }
  ? true
  : S extends { readonly schema: infer Inner }
    ? Marked<Inner>
    : S extends { readonly to: infer To }
      ? Marked<To>
      : false;

/** Optional filters over annotated fields, using their canonical read values. */
export type ListFields<Fields extends Schema.Struct.Fields> = {
  readonly [
    K in keyof Fields as Marked<Fields[K]> extends true ? K : never
  ]: Schema.optionalKey<Schema.toType<Fields[K]>>;
};

/** Parsed equality filters accepted by the Resource's store. */
export type ListFilter<S extends Schema.Struct<Schema.Struct.Fields>> =
  Schema.Struct<ListFields<S["fields"]>>["Type"];

function scalar(ast: SchemaAST.AST): boolean {
  switch (ast._tag) {
    case "String":
    case "Number":
    case "Boolean":
    case "Null":
    case "Enum":
    case "TemplateLiteral":
      return true;
    case "Literal":
      return (
        ast.literal === null ||
        ["string", "number", "boolean"].includes(typeof ast.literal)
      );
    case "Union":
      return ast.types.every(scalar);
    default:
      return false;
  }
}

function rejectNested(
  ast: SchemaAST.AST,
  name: string,
  seen: Set<SchemaAST.AST>,
): void {
  if (seen.has(ast)) return;
  seen.add(ast);
  if (isListKey(Schema.make<Schema.Top>(ast))) {
    throw new Error(`Resource listKey must be on a top-level field: ${name}`);
  }
  for (const child of children(ast)) rejectNested(child, name, seen);
}

function children(ast: SchemaAST.AST): readonly SchemaAST.AST[] {
  switch (ast._tag) {
    case "Objects":
      return [
        ...ast.propertySignatures.map((property) => property.type),
        ...ast.indexSignatures.flatMap((index) => [
          index.parameter,
          index.type,
        ]),
      ];
    case "Arrays":
      return [...ast.elements, ...ast.rest];
    case "Union":
      return ast.types;
    case "Suspend":
      return [ast.thunk()];
    case "Declaration":
      return ast.typeParameters;
    default:
      return [];
  }
}

/**
 * Compiles entity annotations into a list schema and its public key metadata.
 * Filters use canonical scalar values, without create defaults or object-wide
 * invariants. Unknown keys are rejected by the Resource's strict boundary parse.
 *
 * @throws If a listKey is nested or names a non-scalar field.
 * @example
 * ```ts
 * const {schema, keys} = deriveListSchema(Entity);
 * ```
 */
export function deriveListSchema<Fields extends Schema.Struct.Fields>(
  entity: Schema.Struct<Fields>,
) {
  const fields: Record<string, Schema.Top> = {};
  for (const [name, field] of Object.entries(entity.fields)) {
    const value = Schema.toType(field);
    const marked = isListKey(field);
    if (marked && !scalar(value.ast)) {
      throw new Error(`Resource listKey must be scalar: ${name}`);
    }
    for (const child of children(value.ast))
      rejectNested(child, name, new Set());
    if (marked) fields[name] = Schema.optionalKey(value);
  }
  const keys = Object.keys(fields);
  const shape = Schema.Struct(fields);
  // An empty Effect Struct accepts non-object values; list always takes an object.
  const schema = keys.length
    ? shape
    : shape.check(
        Schema.makeFilter(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            Reflect.ownKeys(value).length === 0,
        ),
      );
  return {
    schema: schema as Schema.Struct<ListFields<Fields>>,
    keys,
  };
}
