// Purpose: Verify the desktop serves only bundled assets and explicit SPA navigations.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { origin, resolveAsset } from "./assets";

test("serves bundle files and SPA documents without exposing paths or masking missing assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openchart-desktop-assets-"));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<html>OpenChart</html>");
    await writeFile(join(directory, "assets/app.js"), "export {};");
    expect(
      await resolveAsset(directory, new Request(`${origin}/assets/app.js`)),
    ).toBe(join(directory, "assets/app.js"));
    expect(
      await resolveAsset(
        directory,
        new Request("openchart://app/assets/app.js"),
        "openchart://app",
      ),
    ).toBe(join(directory, "assets/app.js"));
    expect(
      await resolveAsset(
        directory,
        new Request("openchart://foreign/assets/app.js"),
        "openchart://app",
      ),
    ).toBeUndefined();
    expect(
      await resolveAsset(
        directory,
        new Request(`${origin}/app/discussions`, {
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe(join(directory, "index.html"));
    expect(
      await resolveAsset(
        directory,
        new Request("openchart://app/auth/register/continue", {
          method: "HEAD",
        }),
        "openchart://app",
      ),
    ).toBe(join(directory, "index.html"));
    for (const request of [
      new Request(`${origin}/assets/missing.js`),
      new Request(`${origin}/assets/missing.js`, { method: "HEAD" }),
      new Request(`${origin}/assets/missing`, { method: "HEAD" }),
      new Request(`${origin}/assets/missing.js`, {
        headers: { accept: "text/html" },
      }),
      new Request(`${origin}/api/auth/me`, { method: "HEAD" }),
      new Request(`${origin}/api`, { headers: { accept: "text/html" } }),
      new Request(`${origin}/api/auth/me`, {
        headers: { accept: "text/html" },
      }),
      new Request(`${origin}/assets/app.js`, { method: "POST" }),
      new Request("https://other.test/assets/app.js"),
      new Request(`${origin}/..%2fsecret.txt`, {
        headers: { accept: "text/html" },
      }),
      new Request(`${origin}/%ZZ`),
      new Request(`${origin}/%00`),
    ]) {
      expect(await resolveAsset(directory, request)).toBeUndefined();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
