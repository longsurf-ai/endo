// Purpose: Bounds core test workers while retaining per-file isolation.

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          globalSetup: ["./server/agent/workflow/generate-workflow-types.ts"],
          exclude: [...configDefaults.exclude, "app/**"],
        },
      },
    ],
  },
});
