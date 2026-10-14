// Purpose: Verify the Desktop renderer development server configuration.

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "vite";
import { expect, test } from "vitest";

test("serves the Desktop renderer over its configured loopback HTTP port", async () => {
  const root = dirname(
    createRequire(import.meta.url).resolve("@openchart/app/package.json"),
  );
  const cacheDir = await mkdtemp(join(tmpdir(), "reagent-vite-"));
  const shared = {
    root,
    configFile: join(root, "vite.config.ts"),
    cacheDir,
    logLevel: "silent" as const,
  };
  const desktop = await createServer({
    ...shared,
    server: { host: "127.0.0.1", port: 43875, strictPort: false, open: false },
  });
  try {
    expect(desktop.config.server.https).toBeUndefined();
    expect(desktop.config.server.port).toBe(43875);
    expect(desktop.config.server.strictPort).toBe(false);
    await desktop.listen();
    const address = desktop.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP port");
    expect(address.port).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${address.port}/`)).status).toBe(200);
  } finally {
    await desktop.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
