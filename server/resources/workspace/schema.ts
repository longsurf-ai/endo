// Purpose: Persists registered workspace directories independently of their files.

import {
  resourceEnvelopeChecks,
  resourceEnvelopeColumns,
} from "@openchart/server/lib/resource/envelope-columns";
import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A registration owns its identity and immutable canonical directory, never its files. */
export const workspaceTable = sqliteTable(
  "workspace",
  {
    ...resourceEnvelopeColumns(),
    root: text("root").notNull().unique(),
  },
  (table) => [
    ...resourceEnvelopeChecks("workspace", table),
    check("workspace_root_check", sql`length(${table.root}) > 0`),
  ],
);
