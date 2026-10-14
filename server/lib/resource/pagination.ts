// Purpose: Owns bounded Resource lists and opaque cursor encoding at their public boundary.

import { Schema } from "effect";

import { Timestamp } from "./envelope";

/** Number of entities returned when a list omits its limit. */
export const DEFAULT_PAGE_SIZE = 50;
/** Maximum number of entities returned by one Resource list. */
export const MAX_PAGE_SIZE = 200;

const ListPosition = Schema.Struct({
  createdAt: Timestamp,
  updatedAt: Timestamp,
  id: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

// Public cursors are opaque strings; only shared pagination interprets their position.
/** Base64url JSON codec: wire tokens decode once into a Store's exclusive position. */
export const ListCursor = Schema.String.annotate({
  description:
    "Opaque pagination token. Copy nextCursor unchanged and keep the same filter, order and orderBy.",
}).pipe(
  Schema.decodeTo(Schema.StringFromBase64Url),
  Schema.decodeTo(Schema.fromJsonString(ListPosition)),
);
/** Decoded position; remains usable after the referenced row is deleted. */
export type ListPosition = typeof ListPosition.Type;

/** List direction; a cursor continues in the direction it came from. */
export const ListOrder = Schema.Literals(["asc", "desc"]);
/** Parsed list direction. */
export type ListOrder = typeof ListOrder.Type;

/** Existing envelope timestamp used for SQL ordering; defaults to creation time. */
export const ListOrderBy = Schema.Literals(["createdAt", "updatedAt"]);
export type ListOrderBy = typeof ListOrderBy.Type;

/** The bounded SQL window requested from a Store, including one lookahead row. */
export interface ListWindow {
  readonly limit: number;
  readonly cursor?: ListPosition;
  /** Omitted means ascending; descending returns the newest entity first. */
  readonly order?: ListOrder;
  readonly orderBy?: ListOrderBy;
}

/** Internal decoded page; null means no further row existed in this transaction. */
export interface ListPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: ListPosition | null;
}

/**
 * Wraps resource-specific filters in the shared pagination contract.
 *
 * @example
 * ```ts
 * const input = listInputSchema(filters);
 * // Wire: {filter?, limit?, cursor?, order?: "asc" | "desc", orderBy?: "createdAt" | "updatedAt"}
 * // Parsed: cursor is the validated {createdAt, updatedAt, id} Store position.
 * // Keep the same filter, order and orderBy while following nextCursor.
 * // Defaults: orderBy: "createdAt", order: "asc".
 * ```
 */
export function listInputSchema<Filter extends Schema.Struct.Fields>(
  filter: Schema.Struct<Filter>,
) {
  return Schema.Struct({
    filter: Schema.optionalKey(filter),
    limit: Schema.optionalKey(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE }),
      ),
    ),
    cursor: Schema.optionalKey(ListCursor),
    order: Schema.optionalKey(ListOrder),
    orderBy: Schema.optionalKey(ListOrderBy),
  });
}

/** Shared list input schema retaining each Resource's concrete filter fields. */
export type ListInputSchema<Filter extends Schema.Struct.Fields> = ReturnType<
  typeof listInputSchema<Filter>
>;

/**
 * Removes the lookahead row and derives the next exclusive cursor.
 *
 * @example
 * ```ts
 * const page = listPage(rows, limit);
 * ```
 */
export function listPage<Item extends ListPosition>(
  rows: readonly Item[],
  limit: number,
): ListPage<Item> {
  if (rows.length > limit + 1) {
    throw new Error("Resource Store exceeded its bounded list window");
  }
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt, updatedAt: last.updatedAt, id: last.id }
        : null,
  };
}

const encodeCursor = Schema.encodeSync(ListCursor);

/**
 * Encodes an internal page's continuation position for HTTP and Agent callers.
 * @example
 * const result = encodeListPage(listPage(rows, limit));
 * // result.nextCursor is an opaque string or null.
 */
export function encodeListPage<Item>(page: ListPage<Item>) {
  return {
    items: page.items,
    nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
  };
}
