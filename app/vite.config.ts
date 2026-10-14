// Purpose: Configure Desktop renderer assets and app component tests.
/// <reference types="vitest" />
/// <reference types="vite/client" />

import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsconfigPaths from "vite-tsconfig-paths";
import { workflowTypes } from "./tooling/workflow-types";

export default defineConfig({
  base: "./",
  envPrefix: "VITE_APP_",
  plugins: [
    react(),
    viteTsconfigPaths({ projects: ["../tsconfig.json"] }),
    workflowTypes(),
  ],
  worker: { format: "es" },
  resolve: {
    dedupe: [
      "monaco-editor",
      "vscode",
      "react",
      "react-dom",
      "@assistant-ui/core",
      "@assistant-ui/react",
      "@tanstack/react-query",
    ],
  },
  test: {
    maxWorkers: 4,
    globals: true,
    environment: "./tooling/jsdom-environment.ts",
    setupFiles: "./src/testing/setup-tests.ts",
    exclude: [
      "**/node_modules/**",
      "**/e2e/**",
      "src/features/agent/ag-ui/**/*.test.ts",
      "src/features/agent/components/thread/transcript/markdown/__tests__/markdown-math.test.ts",
      "src/lib/agent/**/*.test.{ts,tsx}",
      "src/app/connection/**/*.test.tsx",
      "tooling/**",
    ],
    coverage: {
      include: ["src/**"],
    },
  },
  optimizeDeps: {
    // EmbedPDF's snippet is self-contained ESM whose default `new URL("pdfium.wasm",
    // import.meta.url)` the plugin below cannot resolve, failing the whole startup batch.
    // OOXML's parsers use the same pattern (its README requires this exclude on Vite 7).
    exclude: ["fsevents", "@embedpdf/snippet", "@silurus/ooxml"],
    // VS Code themes and TextMate assets must retain their package URLs after
    // esbuild moves the modules into Vite's development dependency cache.
    esbuildOptions: { plugins: [importMetaUrlPlugin] },
  },
  build: {
    // The desktop CSP allows fetching bundled assets, not data: URLs.
    assetsInlineLimit: 0,
    rollupOptions: {
      external: ["fs/promises"],
      output: {
        experimentalMinChunkSize: 3500,
      },
    },
  },
});
