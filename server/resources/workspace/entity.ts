// Purpose: Derives workspace registration contracts from the owning SQLite table.

import { defineId } from "@openchart/identifier";
import { envelopeFields } from "@openchart/server/lib/resource/envelope";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { workspaceTable } from "./schema";

/** Branded identity retained for the lifetime of one directory registration. */
export const WorkspaceId = defineId("wsp", "Workspace.ID");
/** Identifier of a registered workspace, independent of relative file paths. */
export type WorkspaceId = typeof WorkspaceId.Type;

const columns = createSelectSchema(workspaceTable, {
  root: (schema) => schema.check(Schema.isMinLength(1)),
});

/** A fixed physical directory plus the shared Resource envelope. */
export const WorkspaceEntity = Schema.Struct({
  ...envelopeFields(WorkspaceId),
  root: columns.fields.root,
});
