// Purpose: Verify the Desktop renderer's development server optimizes its dependencies before the first page load.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { expect, test } from "vitest";

import { rendererConfig } from "./renderer-config.ts";

test("the startup dependency scan reaches the lazily loaded code editor", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "openchart-vite-"));
  const server = await createServer({
    ...rendererConfig(),
    cacheDir,
    logLevel: "silent",
    // Middleware mode starts the dependency optimizer without binding ports.
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const optimizer = server.environments.client.depsOptimizer;
    await optimizer?.scanProcessing;
    // A dependency first found on file open is optimized again mid-session, and the
    // editor's stale import of it fails, showing "Couldn't display this widget."
    expect(Object.keys(optimizer?.metadata.discovered ?? {})).toContain(
      "@monaco-editor/react",
    );
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}, 60_000);
