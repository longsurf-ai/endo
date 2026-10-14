// Purpose: Owns Resource field metadata and registration of safely rebindable writable checks.

import { Schema, SchemaAST } from "effect";

/** Annotation key recorded on a field schema that only server-owned code may write. */
export const SERVER_MANAGED = "@openchart/resource/serverManaged";

/** Annotation identifying a top-level scalar available for list equality filters. */
export const LIST_KEY = "@openchart/resource/listKey";

/** A queryable field, retaining other annotations in both its schema and type. */
export type ListKey<S extends Schema.Top> = S["Rebuild"] & {
  readonly [LIST_KEY]: true;
  readonly Rebuild: ListKey<S>;
};

/**
 * Exposes a top-level scalar field as an optional equality filter on list.
 * Independent of write access; composition rejects nested or non-scalar keys.
 *
 * @example
 * ```ts
 * const fields = {scheduleId: listKey(Schema.String)};
 * ```
 */
export function listKey<
  S extends Schema.Top & Schema.Schema<string | number | boolean | null>,
>(schema: S): ListKey<S> {
  return schema.annotate({ [LIST_KEY]: true }) as ListKey<S>;
}

/**
 * Detects the list annotation, including metadata retained by later checks.
 *
 * @example
 * ```ts
 * isListKey(listKey(Schema.String)); // => true
 * ```
 */
export function isListKey(schema: Schema.Constraint): boolean {
  return hasAnnotation(schema.ast, LIST_KEY);
}

/** A field marked read-only to clients in both schema metadata and types. */
export type ServerManaged<S extends Schema.Top> = S["Rebuild"] & {
  readonly [SERVER_MANAGED]: true;
  readonly Rebuild: ServerManaged<S>;
};

/**
 * Marks a field as server-managed: present on reads, absent from client
 * create/patch inputs. Envelope fields carry it; domain fields normally do not.
 * Internal Resource transitions may write managed domain fields through the
 * same Store insert/save methods. This annotation restricts client writes.
 *
 * @param schema - The field schema to annotate.
 * @returns The same schema carrying the server-managed annotation.
 *
 * @example
 * ```ts
 * const fields = {revision: serverManaged(Schema.Int)};
 * ```
 */
export function serverManaged<S extends Schema.Top>(
  schema: S,
): ServerManaged<S> {
  return schema.annotate({ [SERVER_MANAGED]: true }) as ServerManaged<S>;
}

/**
 * Reports whether a field schema carries the server-managed annotation.
 *
 * @param schema - Any field schema.
 * @returns `true` when the field is written only by the framework.
 *
 * @example
 * ```ts
 * isServerManaged(serverManaged(Schema.Int)); // => true
 * ```
 */
export function isServerManaged(schema: Schema.Top): boolean {
  return hasAnnotation(schema.ast, SERVER_MANAGED);
}

function annotatedCheck(check: SchemaAST.Check<unknown>, key: string): boolean {
  return (
    check.annotations?.[key] === true ||
    (check._tag === "FilterGroup" &&
      check.checks.some((item) => annotatedCheck(item, key)))
  );
}

function hasAnnotation(ast: SchemaAST.AST, key: string): boolean {
  return (
    ast.annotations?.[key] === true ||
    ast.checks?.some((check) => annotatedCheck(check, key)) === true
  );
}

// Effect clones Filter objects for annotate/abort, retaining their run function.
// Only framework-created predicates may be rebound to a smaller writable shape.
const writableChecks = new WeakMap<
  SchemaAST.Filter<unknown>["run"],
  (target: SchemaAST.AST) => SchemaAST.Filter<unknown>
>();

/** Registers the rebind operation of a framework-owned writable invariant. @internal */
export function registerWritableCheck(
  check: SchemaAST.Filter<unknown>,
  rebind: (target: SchemaAST.AST) => SchemaAST.Filter<unknown>,
): void {
  writableChecks.set(check.run, rebind);
}

/** Whether every check in a group is a framework-owned writable invariant. @internal */
export function isWritableCheck(check: SchemaAST.Check<unknown>): boolean {
  return check._tag === "Filter"
    ? writableChecks.has(check.run)
    : check.checks.every(isWritableCheck);
}

/** Rebinds an invariant to the target's projection; arbitrary filters fail closed. @internal */
export function rebindWritableCheck(
  check: SchemaAST.Check<unknown>,
  target: SchemaAST.AST,
): SchemaAST.Check<unknown> {
  if (check._tag === "Filter") {
    const rebind = writableChecks.get(check.run);
    if (rebind) {
      return new SchemaAST.Filter(
        rebind(target).run,
        check.annotations,
        check.aborted,
      );
    }
  }
  if (check._tag === "FilterGroup") {
    return new SchemaAST.FilterGroup(
      check.checks.map((item) => rebindWritableCheck(item, target)) as [
        SchemaAST.Check<unknown>,
        ...Array<SchemaAST.Check<unknown>>,
      ],
      check.annotations,
    );
  }
  throw new Error("Only writable Resource invariants can be rebound");
}
