// Purpose: Binds Resource CRUD, revisions, and entity decoding to transaction-only transitions.

import { Effect, Schema } from "effect";

import {
  type Id,
  type ResourceShape,
  STRICT_PARSE_OPTIONS,
  type EntityBody,
  type WritableEntityBody,
} from "./definition";
import type { Revision } from "./envelope";
import { ResourceStateInvalid } from "./errors";
import { checkRevision, loadExisting, toEntity } from "./entity-operations";
import { type Patch, applyJsonPatch } from "./patch";
import { resourceIssues } from "./invariant";
import type { Row, Tx } from "./store";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListPosition,
  listPage,
  encodeListPage,
} from "./pagination";
import * as Transition from "./transition";

/** Input accepted by a Resource's intrinsic patch transition. */
export interface PatchInput<D extends ResourceShape> {
  readonly id: Id<D>;
  /** Revision last read by the caller; compared within the write transaction. */
  readonly expectedRevision: Revision;
  readonly operations: Patch;
}

/**
 * Parses a stored row's body with the domain schema.
 *
 * A row that fails its own schema is corrupt state, not user input, so the
 * failure is a defect rather than a typed error.
 */
function decodeEntityBody<D extends ResourceShape>(
  definition: D,
  row: Row,
): Effect.Effect<EntityBody<D>> {
  return Schema.decodeUnknownEffect(
    definition.body,
    STRICT_PARSE_OPTIONS,
  )(row.body).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `Resource ${definition.name} ${row.id} failed its body schema: ${error.message}`,
        ),
    ),
    Effect.orDie,
  );
}

/** Intrinsic operations bound to one Resource's schemas and Store. */
export type IntrinsicTransitions<D extends ResourceShape> = ReturnType<
  typeof createIntrinsicTransitions<D>
>;

/**
 * Binds the shared Resource operations without performing IO or generating ids.
 *
 * Each operation accepts parsed input and returns a transition with no external
 * resolver. Store reads, revision checks, patching, writes, and stored-entity
 * decoding all run inside apply using the supplied transaction.
 *
 * @param definition - Resource schemas and persistence mapping to bind once.
 * @returns Intrinsic get, list, listAll, create, patch, and remove factories.
 *
 * @example
 * ```ts
 * const transitions = createIntrinsicTransitions(definition);
 * const entity = yield* Transactor.run(transitions.create(body));
 * ```
 */
export function createIntrinsicTransitions<D extends ResourceShape>(
  definition: D,
) {
  const readPage = (tx: Tx, input: D["listSchema"]["Type"]) =>
    Effect.gen(function* () {
      const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      const rows = yield* definition.store.list(tx, input.filter ?? {}, {
        limit: limit + 1,
        cursor: input.cursor,
        order: input.order,
        orderBy: input.orderBy,
      });
      const page = listPage(rows, limit);
      const items = yield* Effect.forEach(page.items, (row) =>
        toEntity<D["entity"]>(definition.name, definition.entity, row),
      );
      return { items, nextCursor: page.nextCursor };
    });
  const list = (input: D["listSchema"]["Type"] = {}) =>
    Transition.from((tx) =>
      readPage(tx, input).pipe(Effect.map(encodeListPage)),
    );

  return {
    /**
     * Reads and decodes one entity; a missing row fails with ResourceNotFound.
     *
     * @example
     * ```ts
     * const entity = yield* Transactor.run(resource.transitions.get(id));
     * ```
     */
    get(id: Id<D>) {
      return Transition.from((tx) =>
        loadExisting(definition.store, definition.name, tx, id).pipe(
          Effect.flatMap((row) =>
            toEntity<D["entity"]>(definition.name, definition.entity, row),
          ),
        ),
      );
    },

    /**
     * Lists a bounded page ordered by the selected timestamp and ID; defaults to creation time ascending.
     * Store applies filters, the exclusive cursor, and the lookahead limit in SQL.
     *
     * @example
     * ```ts
     * const page = yield* Transactor.run(resource.transitions.list({limit: 20}));
     * ```
     */
    list,

    /**
     * Reads all matching entities in creation/id order for internal callers.
     * Bounded pages share the supplied transaction; the result array has no
     * total size limit. Additional business filtering belongs to the caller.
     *
     * @example
     * ```ts
     * const entities = yield* Transactor.run(resource.transitions.listAll());
     * ```
     */
    listAll(input: Pick<D["listSchema"]["Type"], "filter"> = {}) {
      return Transition.from((tx) =>
        Effect.gen(function* () {
          const items: D["entity"]["Type"][] = [];
          let cursor: ListPosition | undefined;
          do {
            const page = yield* readPage(tx, {
              ...input,
              limit: MAX_PAGE_SIZE,
              cursor,
            });
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          return items;
        }),
      );
    },

    /**
     * Creates an entity from a parsed writable or complete backend body. Assigns a fresh id
     * and revision 1 during apply; SQLite supplies timestamps. Decodes the full
     * stored entity before commit so a defect rolls back every Store write.
     *
     * @example
     * ```ts
     * const created = yield* Transactor.run(resource.transitions.create(body));
     * ```
     */
    create(body: WritableEntityBody<D> | EntityBody<D>) {
      return Transition.from((tx) =>
        Effect.gen(function* () {
          const row = yield* definition.store.insert(tx, {
            id: definition.id.create(),
            revision: 1,
            body,
          });
          return yield* toEntity<D["entity"]>(
            definition.name,
            definition.entity,
            row,
          );
        }),
      );
    },

    /**
     * Applies JSON Patch to the writable projection after checking the revision.
     * Parses the final value before save, advances revision once, then decodes
     * the stored entity. Every step shares apply's transaction.
     *
     * @example
     * ```ts
     * const renamed = yield* Transactor.run(resource.transitions.patch({
     *   id,
     *   expectedRevision: 1,
     *   operations: [{op: 'replace', path: '/name', value: 'Rates'}],
     * }));
     * ```
     */
    patch(input: PatchInput<D>) {
      return Transition.from((tx) =>
        Effect.gen(function* () {
          const current = yield* loadExisting(
            definition.store,
            definition.name,
            tx,
            input.id,
          );
          yield* checkRevision(
            definition.name,
            current,
            input.expectedRevision,
          );
          const base = yield* decodeEntityBody(definition, current);
          const patched = yield* applyJsonPatch(
            definition.project(base),
            input.operations,
          );
          const body = yield* Schema.decodeUnknownEffect(
            definition.updateSchema,
            STRICT_PARSE_OPTIONS,
          )(patched).pipe(
            Effect.mapError(
              (error) =>
                new ResourceStateInvalid({
                  resource: definition.name,
                  reason: error.message,
                  issues: resourceIssues(error.issue),
                }),
            ),
          );
          const row = yield* definition.store.save(tx, input.id, {
            body,
            revision: current.revision + 1,
          });
          return yield* toEntity<D["entity"]>(
            definition.name,
            definition.entity,
            row,
          );
        }),
      );
    },

    /**
     * Deletes an existing entity; owned rows follow the Store's FK cascades.
     *
     * @example
     * ```ts
     * yield* Transactor.run(resource.transitions.remove(id));
     * ```
     */
    remove(id: Id<D>) {
      return Transition.from((tx) =>
        Effect.gen(function* () {
          yield* loadExisting(definition.store, definition.name, tx, id);
          yield* definition.store.remove(tx, id);
        }),
      );
    },
  };
}
