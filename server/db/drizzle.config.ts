// Purpose: Discovers application-owned schemas for migration generation.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./agent/**/schema.ts", "./resources/**/schema.ts"],
  out: "./db/migration",
  dbCredentials: {
    url: ":memory:",
  },
});
