// Purpose: Declares writable Resource invariants with typed paths and structured Effect Schema failures.

import { Schema, type SchemaAST, SchemaIssue } from "effect";

import { registerWritableCheck } from "./annotation";
import { deriveWriteShape, type WritableSchema } from "./write-schema";

/** A field diagnostic. Paths are RFC 6901 pointers into the rejected candidate value. */
export const ResourceIssue = Schema.Struct({
  code: Schema.String,
  path: Schema.String,
  message: Schema.String,
  actual: Schema.optionalKey(Schema.Json),
  expected: Schema.optionalKey(Schema.Json),
});

/** A schema or invariant failure, suitable for UI display and agent repair. */
export type ResourceIssue = typeof ResourceIssue.Type;

/**
 * Paths through finite JSON values. Arrays take numeric indices; primitive
 * leaves (including branded ids) have no children. A union permits paths from
 * any branch; the rule must select the branch that exists in the actual value.
 * `[]` addresses the value itself. This checks shape, not array bounds.
 * A recursive type is typed down to where it first nests inside itself; any
 * path continues from there, so rules walking recursion narrow with `at`.
 */
export type Path<T> = ReadonlyArray<string | number> & Paths<T, never>;

// Whether T equals a type on its own ancestry, meaning the value recurses.
type Recurs<T, Ancestors> = true extends (
  Ancestors extends unknown
    ? [T] extends [Ancestors]
      ? [Ancestors] extends [T]
        ? true
        : never
      : never
    : never
)
  ? true
  : false;

type Paths<T, Ancestors> = T extends
  string | number | boolean | null | undefined
  ? readonly []
  : Recurs<T, Ancestors> extends true
    ? ReadonlyArray<string | number>
    : T extends ReadonlyArray<infer Item>
      ? number extends T["length"]
        ? readonly [] | readonly [number, ...Paths<Item, Ancestors | T>]
        : | readonly []
          | {
              [
                K in Exclude<keyof T, keyof ReadonlyArray<unknown>>
              ]: K extends `${infer Index extends number}`
                ? readonly [Index, ...Paths<T[K], Ancestors | T>]
                : never;
            }[Exclude<keyof T, keyof ReadonlyArray<unknown>>]
      : T extends object
        ? | readonly []
          | {
              [K in keyof T & (string | number)]-?: readonly [
                K,
                ...Paths<T[K], Ancestors | T>,
              ];
            }[keyof T & (string | number)]
        : readonly [];

/** The value a path addresses; a union resolves each member that has the step. */
export type At<T, P> = P extends readonly [infer Head, ...infer Tail]
  ? At<
      T extends ReadonlyArray<infer Item>
        ? Item
        : T extends object
          ? Head extends keyof T
            ? T[Head]
            : never
          : never,
      Tail
    >
  : T;

/** Soft assertions: failures accumulate, and no assertion narrows a value's type. */
export type InvariantExpectation<Actual> = {
  /** Compares with Object.is and reports the supplied actual and expected values. */
  readonly toBe: (expected: Schema.Json) => void;
} & (Actual extends string | ReadonlyArray<unknown>
  ? {
      /** Compares a string or array's length; diagnostics contain the numeric lengths. */
      readonly toHaveLength: (expected: number) => void;
    }
  : unknown);

/** A per-evaluation assertion context whose paths are relative to its value. */
export interface InvariantContext<Value> {
  /** Starts an assertion and identifies the field responsible for a failure. */
  readonly expect: <Actual extends Schema.Json>(
    actual: Actual,
    options: { readonly path: Path<Value> },
  ) => InvariantExpectation<Actual>;
  /**
   * Scopes later paths to a nested value. Failures still point into the whole
   * candidate. Recursive rules call it once per level, keeping paths typed.
   *
   * @example
   * ```ts
   * const visit = (node: Node, at: InvariantContext<Node>) => {
   *   at.expect(node.name, {path: ['name']}).toBe('root');
   *   node.children.forEach((child, i) => visit(child, at.at(['children', i])));
   * };
   * ```
   */
  readonly at: <const P extends Path<Value>>(
    path: P,
  ) => InvariantContext<At<Value, P>>;
}

/** A pure, synchronous business rule. Framework parsing owns its execution. */
export interface Invariant<Value> {
  readonly description: string;
  readonly code: string;
  readonly check: (value: Value, context: InvariantContext<Value>) => undefined;
}

/** Declares one named rule with a stable diagnostic code. */
export type InvariantFactory<Value> = (
  description: string,
  check: Invariant<Value>["check"],
  error: { readonly code: string },
) => Invariant<Value>;

const diagnostics = new WeakMap<
  SchemaIssue.Issue,
  Omit<ResourceIssue, "path">
>();

function pointer(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map(
      (segment) =>
        "/" + String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
    )
    .join("");
}

// The untyped runtime shape behind every InvariantContext.
interface Scope {
  readonly expect: (
    actual: Schema.Json,
    options: { readonly path: ReadonlyArray<string | number> },
  ) => InvariantExpectation<Schema.Json>;
  readonly at: (path: ReadonlyArray<string | number>) => Scope;
}

function compile<Value>(
  source: SchemaAST.AST,
  rules: ReadonlyArray<Invariant<Value>>,
): SchemaAST.Filter<unknown> {
  const writes = deriveWriteShape(
    Schema.make<Schema.Codec<Schema.Json>>(source),
  );
  const filter = Schema.makeFilter<unknown>((input) => {
    // The owner already parsed structure. Projection strips even nested managed
    // fields without a second parse, on full reads as well as derived writes.
    const value = writes.project(input as Schema.Json) as Value;
    const failures: Array<SchemaIssue.Issue> = [];
    for (const rule of rules) {
      const scope = (prefix: ReadonlyArray<string | number>): Scope => ({
        expect: (actual, { path }) => {
          const compare = (
            received: Schema.Json,
            expected: Schema.Json,
            detail: string,
          ) => {
            if (Object.is(received, expected)) return;
            const message = `${rule.description}. ${detail}`;
            const issue = new SchemaIssue.InvalidValue({ message });
            diagnostics.set(issue, {
              code: rule.code,
              message,
              actual: received,
              expected,
            });
            failures.push(new SchemaIssue.Pointer([...prefix, ...path], issue));
          };
          return {
            toBe: (expected: Schema.Json) =>
              compare(
                actual,
                expected,
                `Expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`,
              ),
            toHaveLength: (expected: number) => {
              if (typeof actual !== "string" && !Array.isArray(actual)) {
                throw new Error("toHaveLength requires a string or array");
              }
              compare(
                actual.length,
                expected,
                `Expected length ${expected}; received ${actual.length}.`,
              );
            },
          } as InvariantExpectation<typeof actual>;
        },
        at: (path) => scope([...prefix, ...path]),
      });
      // Paths are typed at each call site; the runtime only concatenates them.
      const context = scope([]) as InvariantContext<Value>;
      rule.check(value, context);
    }
    return failures;
  });
  registerWritableCheck(filter, (target) => compile(target, rules));
  return filter;
}

/**
 * Attaches domain rules to an entity. Callbacks and paths see only its writable
 * projection; rules survive body/create/update derivation and run when these
 * schemas are parsed. Unexpected callback exceptions remain defects.
 *
 * @example
 * ```ts
 * const Entity = withInvariants(Schema.Struct({names: Schema.Array(Schema.String)}), invariant => [
 *   invariant('Exactly one name', (value, {expect}) => {
 *     expect(value.names, {path: ['names']}).toHaveLength(1);
 *   }, {code: 'example.name_count'}),
 * ]);
 * ```
 */
export function withInvariants<
  S extends Schema.Top & Schema.Schema<Schema.JsonObject>,
>(
  schema: S,
  declare: (
    invariant: InvariantFactory<WritableSchema<S>["Type"]>,
  ) => ReadonlyArray<Invariant<WritableSchema<S>["Type"]>>,
): S["Rebuild"] {
  const rules = declare((description, check, { code }) => ({
    description,
    check,
    code,
  }));
  if (new Set(rules.map((rule) => rule.code)).size !== rules.length) {
    throw new Error(
      "Resource invariant codes must be unique within a declaration",
    );
  }
  return schema.check(compile(schema.ast, rules));
}

/**
 * Converts schema failures to structured diagnostics without parsing messages.
 * Invariant metadata is preserved; ordinary schema failures use `schema.invalid`.
 * Paths refer to the parsed candidate, including enclosing objects and arrays.
 */
export function resourceIssues(
  issue: SchemaIssue.Issue,
): ReadonlyArray<ResourceIssue> {
  const result: Array<ResourceIssue> = [];
  const visit = (
    current: SchemaIssue.Issue,
    path: ReadonlyArray<PropertyKey>,
  ): void => {
    switch (current._tag) {
      case "Pointer":
        return visit(current.issue, [...path, ...current.path]);
      case "Filter":
        if (
          current.issue._tag === "InvalidValue" &&
          !diagnostics.has(current.issue)
        ) {
          result.push({
            code: "schema.invalid",
            path: pointer(path),
            message: SchemaIssue.makeFormatterDefault()(current),
          });
          return;
        }
        return visit(current.issue, path);
      case "Encoding":
        return visit(current.issue, path);
      case "Composite":
      case "AnyOf":
        if (current.issues.length) {
          current.issues.forEach((child) => visit(child, path));
          return;
        }
    }
    result.push({
      ...(diagnostics.get(current) ?? {
        code: "schema.invalid",
        message: SchemaIssue.makeFormatterDefault()(current),
      }),
      path: pointer(path),
    });
  };
  visit(issue, []);
  return result;
}
