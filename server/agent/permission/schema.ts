// Purpose: Stores application-scoped remembered permission grants.

import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

/** Remembered grants for this database; configured deny takes precedence. */
export const permissionGrants = sqliteTable(
  "agent_permission_grants",
  {
    id: text("id").primaryKey(),
    // Permission operation from ask.action, e.g. 'read' or 'edit'.
    // Matched as a wildcard pattern against later requests' actions.
    action: text("action").notNull(),

    // Allowed target pattern from ask.save, e.g. '/notes/*' for 'read'.
    // The caller defines the target (path, command, etc.); no Resource FK.
    resource: text("resource").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (table) => [
    uniqueIndex("uniq_agent_permission_grants_action_resource").on(
      table.action,
      table.resource,
    ),
  ],
);
