// Purpose: Derives client-writable schemas and projections from server-managed field annotations.

import { Schema, SchemaAST } from "effect";

import {
  SERVER_MANAGED,
  isServerManaged,
  isWritableCheck,
  rebindWritableCheck,
} from "./annotation";

type Managed<S> = S extends { readonly [SERVER_MANAGED]: true }
  ? true
  : S extends { readonly schema: infer Inner }
    ? Managed<Inner>
    : S extends { readonly to: infer To }
      ? Managed<To>
      : false;

/** Struct fields writable by clients, including recursive field projection. */
export type WritableFields<Fields extends Schema.Struct.Fields> = {
  readonly [
    K in keyof Fields as Managed<Fields[K]> extends true ? never : K
  ]: WritableSchema<Fields[K]>;
};

// An empty writable object admits no properties, including on inferred variables.
// TypeScript's {} would also admit partial backend bodies and primitive values.
type WritableStruct<Fields extends Schema.Struct.Fields> =
  keyof WritableFields<Fields> extends never
    ? Schema.Codec<Readonly<Record<PropertyKey, never>>>
    : Schema.Struct<WritableFields<Fields>>;

/** A schema with server-managed fields removed from objects and collections. */
export type WritableSchema<S extends Schema.Constraint> =
  Schema.Constraint extends S
    ? Schema.Constraint
    : S extends Schema.optionalKey<infer Inner>
      ? Schema.optionalKey<WritableSchema<Inner>>
      : S extends Schema.Struct<infer Fields>
        ? WritableStruct<Fields>
        : S extends Schema.Tuple<infer Elements>
          ? Schema.Tuple<{
              readonly [K in keyof Elements]: WritableSchema<Elements[K]>;
            }>
          : S extends Schema.NonEmptyArray<infer Element>
            ? Schema.NonEmptyArray<WritableSchema<Element>>
            : S extends Schema.$Array<infer Element>
              ? Schema.$Array<WritableSchema<Element>>
              : S extends Schema.Union<infer Members>
                ? Schema.Union<{
                    readonly [K in keyof Members]: WritableSchema<Members[K]>;
                  }>
                : S extends Schema.$Record<infer Key, infer Value>
                  ? Schema.$Record<Key, WritableSchema<Value>>
                  : S extends Schema.suspend<infer Inner>
                    ? Schema.suspend<WritableSchema<Inner>>
                    : S extends Schema.decodeTo<
                          infer To,
                          infer From,
                          infer RD,
                          infer RE
                        >
                      ? Schema.decodeTo<
                          WritableSchema<To>,
                          WritableSchema<From>,
                          RD,
                          RE
                        >
                      : S;

/** Compiled write surface and its projection of an already parsed read value. */
export interface WriteShape<S extends Schema.Constraint> {
  readonly schema: Schema.Codec<
    WritableSchema<S>["Type"],
    WritableSchema<S>["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"]
  >;
  /** Removes server-managed data from the client patch document. */
  readonly project: (value: Schema.Json) => Schema.Json;
}

function managed(ast: SchemaAST.AST): boolean {
  return isServerManaged(Schema.make<Schema.Top>(ast));
}

function strictObject(ast: SchemaAST.Objects): SchemaAST.Objects {
  // Effect's empty Struct accepts arbitrary non-null values. A write object
  // with no remaining fields must instead accept exactly an empty object.
  if (ast.propertySignatures.length || ast.indexSignatures.length) return ast;
  return Schema.make<Schema.Top>(ast).check(
    Schema.makeFilter(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Reflect.ownKeys(value).length === 0,
    ),
  ).ast as SchemaAST.Objects;
}

// Whether derive changes anything reachable from `ast`: a managed field to
// remove or an empty object to make strict. Mirrors derive's cases. Recursive
// schemas reach themselves, so this walks the schema graph, not its unfolding.
function rewrites(
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST> = new Set(),
): boolean {
  if (seen.has(ast)) return false;
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      return (
        (!ast.propertySignatures.length && !ast.indexSignatures.length) ||
        [...ast.propertySignatures, ...ast.indexSignatures].some(
          ({ type }) => managed(type) || rewrites(type, seen),
        )
      );
    case "Arrays":
      return [...ast.elements, ...ast.rest].some((type) =>
        rewrites(type, seen),
      );
    case "Union":
      return ast.types.some((type) => rewrites(type, seen));
    case "Suspend":
      return rewrites(ast.thunk(), seen);
    default:
      return false;
  }
}

// `suspends` maps each source Suspend to its derivation, so a cycle in the
// source becomes the same cycle in the result instead of an infinite unfolding.
function derive(
  source: SchemaAST.AST,
  suspends: Map<SchemaAST.Suspend, SchemaAST.AST>,
): SchemaAST.AST {
  let next: SchemaAST.AST;
  switch (source._tag) {
    case "Objects": {
      const properties = source.propertySignatures
        .filter((property) => !managed(property.type))
        .map(
          (property) =>
            new SchemaAST.PropertySignature(
              property.name,
              derive(property.type, suspends),
            ),
        );
      const indexes = source.indexSignatures.map((index) => {
        if (managed(index.type)) {
          throw new Error(
            "Mark the entire record serverManaged instead of its index value",
          );
        }
        return new SchemaAST.IndexSignature(
          index.parameter,
          derive(index.type, suspends),
        );
      });
      const changed =
        properties.length !== source.propertySignatures.length ||
        properties.some(
          (property, i) => property.type !== source.propertySignatures[i]?.type,
        ) ||
        indexes.some(
          (index, i) => index.type !== source.indexSignatures[i]?.type,
        );
      if (!changed) return strictObject(source);
      next = strictObject(
        new SchemaAST.Objects(
          properties,
          indexes,
          source.annotations,
          undefined,
          undefined,
          source.context,
        ),
      );
      break;
    }
    case "Arrays": {
      const recur = (type: SchemaAST.AST) => derive(type, suspends);
      const elements = SchemaAST.mapOrSame(source.elements, recur);
      const rest = SchemaAST.mapOrSame(source.rest, recur);
      if (elements === source.elements && rest === source.rest) return source;
      next = new SchemaAST.Arrays(
        source.isMutable,
        elements,
        rest,
        source.annotations,
        undefined,
        undefined,
        source.context,
      );
      break;
    }
    case "Union": {
      const types = SchemaAST.mapOrSame(source.types, (type) =>
        derive(type, suspends),
      );
      if (types === source.types) return source;
      next = new SchemaAST.Union(
        types,
        source.mode,
        source.annotations,
        undefined,
        undefined,
        source.context,
      );
      break;
    }
    case "Suspend": {
      const known = suspends.get(source);
      if (known) return known;
      // Leaving unchanged recursion untouched keeps its containers' checks and codecs.
      if (!rewrites(source)) return source;
      const suspended = new SchemaAST.Suspend(
        () => target,
        source.annotations,
        undefined,
        undefined,
        source.context,
      );
      // Register before deriving the target, so the cycle closes on this node.
      // Deriving eagerly reports invalid recursive shapes at definition time;
      // parsing forces the thunk only after `target` exists.
      suspends.set(source, suspended);
      const target = derive(source.thunk(), suspends);
      next = suspended;
      break;
    }
    default:
      return source;
  }
  // @agent invariant: Only registered writable invariants can follow a smaller
  // shape. Arbitrary checks/codecs may depend on removed managed fields.
  if (
    source.checks?.some((check) => !isWritableCheck(check)) ||
    source.encoding ||
    ("encodingChecks" in source && source.encodingChecks)
  ) {
    throw new Error(
      "Containers with serverManaged descendants cannot have checks or codecs unless the checks are declared with withInvariants",
    );
  }
  if (source.checks?.length) {
    return source.checks.reduce(
      (schema, check) => schema.check(rebindWritableCheck(check, next)),
      Schema.make<Schema.Top>(next),
    ).ast;
  }
  return next;
}

function project(ast: SchemaAST.AST, value: Schema.Json): Schema.Json {
  switch (ast._tag) {
    case "Objects": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a parsed Resource object");
      }
      const fields = new Map(
        ast.propertySignatures.map((property) => [
          property.name,
          property.type,
        ]),
      );
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) => {
          const field =
            fields.get(key) ??
            ast.indexSignatures.find((index) =>
              Schema.is(Schema.make<Schema.Top>(index.parameter))(key),
            )?.type;
          if (!field)
            throw new Error(`Parsed Resource contains undeclared field ${key}`);
          return managed(field) ? [] : [[key, project(field, entry)]];
        }),
      );
    }
    case "Arrays":
      if (!Array.isArray(value))
        throw new Error("Expected a parsed Resource array");
      return value.map((entry, i) => {
        const tailStart = value.length - Math.max(0, ast.rest.length - 1);
        const element =
          ast.elements[i] ??
          (i >= tailStart ? ast.rest[i - tailStart + 1] : ast.rest[0]);
        if (!element)
          throw new Error("Parsed Resource array has no element schema");
        return project(element, entry);
      });
    case "Union": {
      const member = ast.types.find((type) =>
        Schema.is(Schema.make<Schema.Top>(SchemaAST.toType(type)))(value),
      );
      if (!member) throw new Error("Parsed Resource matches no union member");
      return project(member, value);
    }
    case "Suspend":
      // The value is finite, so recursion ends with its deepest node.
      return project(ast.thunk(), value);
    default:
      return value;
  }
}

/**
 * Compiles a strict client write shape from the complete read schema.
 * Defaults and constraints on unchanged fields survive. Writable invariants
 * rebind to the new projection. Other checks/codecs on a container whose shape
 * changes are rejected rather than silently weakened.
 *
 * Recursive schemas built with `Schema.suspend` derive at any depth. Recursion
 * without managed fields keeps its original schema; otherwise each cycle maps
 * to one derived cycle. Errors are thrown here, never during a later parse.
 * Write types follow the suspended schema's declared type, so a recursive
 * `Schema.Codec<T>` keeps `T` even when the runtime omits managed fields.
 *
 * @throws If a managed field sits in a record value or under a container whose
 * checks or codecs cannot follow the smaller shape.
 *
 * @example
 * ```ts
 * const writes = deriveWriteShape(Schema.Struct({
 *   name: Schema.String, count: serverManaged(Schema.Number),
 * }));
 * writes.project({name: 'Example', count: 3}); // {name: 'Example'}
 * ```
 */
export function deriveWriteShape<S extends Schema.Top>(
  schema: S,
): WriteShape<S> {
  const writable = Schema.make<Schema.Top>(derive(schema.ast, new Map()));
  return {
    schema: writable as WriteShape<S>["schema"],
    project: (value) => project(schema.ast, value),
  };
}
