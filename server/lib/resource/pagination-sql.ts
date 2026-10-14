// Purpose: Applies the shared Resource cursor order and row limit to SQLite queries.

import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import type { ListWindow } from "./pagination";

/**
 * Supplies SQL pagination over any Resource's envelope columns.
 * Stores combine the predicate with domain filters before loading child rows.
 * A descending window flips both the sort and the exclusive cursor comparison,
 * so one cursor position serves either direction.
 *
 * @example
 * ```ts
 * const page = listWindowSql(table, window);
 * const rows = yield* tx.select().from(table)
 *   .where(and(filter, page.where)).orderBy(...page.orderBy).limit(page.limit);
 * ```
 */
export function listWindowSql(
  columns: {
    readonly createdAt: SQLiteColumn;
    readonly updatedAt: SQLiteColumn;
    readonly id: SQLiteColumn;
  },
  window: ListWindow,
) {
  const [after, direction] = window.order === "desc" ? [lt, desc] : [gt, asc];
  const orderBy = window.orderBy ?? "createdAt";
  const timestamp = columns[orderBy];
  return {
    where: window.cursor
      ? or(
          after(timestamp, window.cursor[orderBy]),
          and(
            eq(timestamp, window.cursor[orderBy]),
            after(columns.id, window.cursor.id),
          ),
        )
      : undefined,
    orderBy: [direction(timestamp), direction(columns.id)],
    limit: window.limit,
  };
}
