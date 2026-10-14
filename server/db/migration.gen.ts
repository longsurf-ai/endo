// Purpose: Generated ordered registry for every V2 SQLite migration.

import type { DatabaseMigration } from "./migration";

export const migrations = [
  {
    ...(await import("./migration/20261014191717_initial")).default,
    filename: "20261014191717_initial.ts",
    checksum:
      "7269f65c8dee7bfea4218277f391a55c841664a3bfd94b26d9c5365844dc78fb",
  },
] satisfies DatabaseMigration.RegisteredMigration[];
