// Purpose: Agent client and protocol tests run in Node, independently of the app-wide jsdom harness.
import viteTsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [viteTsconfigPaths({ projects: ["../tsconfig.json"] })],
  test: {
    maxWorkers: 4,
    environment: "node",
    globals: true,
    include: [
      "src/features/agent/ag-ui/**/*.test.ts",
      "src/features/agent/components/thread/transcript/markdown/__tests__/markdown-math.test.ts",
      "src/lib/agent/**/*.test.{ts,tsx}",
      "src/app/connection/**/*.test.tsx",
    ],
  },
});
