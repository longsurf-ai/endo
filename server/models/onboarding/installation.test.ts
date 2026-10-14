// Purpose: Exercises real downloads, archive validation, and atomic publication.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { Effect, Fiber } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { ANTIGRAVITY, CODEX, CLAUDE_CODE } from "@openchart/models/model-tiers";
import { createInstallations, installationTask } from "./installation";
import type { RuntimeArtifact } from "./manifest";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  options: {
    version?: string;
    symlink?: boolean;
    slow?: boolean;
    status?: number;
    /** Archive the payload at the root, as release archives do, instead of under `package/`. */
    flat?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "openchart-install-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const payload = options.flat ? source : path.join(source, "package");
  await mkdir(path.join(payload, "bin"), { recursive: true });
  await writeFile(
    path.join(payload, "bin/codex"),
    `#!${process.execPath}\nconsole.log("codex-cli ${options.version ?? "1.2.3"}");\n`,
    { mode: 0o755 },
  );
  await writeFile(path.join(payload, "bin/companion"), "companion resource", {
    mode: 0o755,
  });
  if (options.symlink)
    await symlink("/tmp/outside", path.join(payload, "escape"));
  const archive = path.join(directory, "fixture.tgz");
  await tar.c({ cwd: source, file: archive, gzip: true }, [
    options.flat ? "bin" : "package",
  ]);
  const bytes = await readFile(archive);
  const requested = vi.fn();
  const server = createServer((_request, response) => {
    requested();
    response.writeHead(options.status ?? 200, {
      "content-type": "application/gzip",
    });
    if (options.slow) response.write(bytes.subarray(0, 10));
    else response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP fixture");
  const artifact: RuntimeArtifact = {
    version: "1.2.3",
    url: `http://127.0.0.1:${address.port}/runtime.tgz`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    layout: options.flat ? "flat" : "npm",
    executable: "bin/codex",
  };
  const root = path.join(directory, "model-providers");
  const make = (pin = artifact) =>
    createInstallations(
      root,
      {
        [CODEX]: { test: pin },
        [CLAUDE_CODE]: { test: pin },
        [ANTIGRAVITY]: { test: pin },
      },
      "test",
    );
  return { root, artifact, make, requested };
}
const signal = () => new AbortController().signal;

test("installs a flat release archive at the payload root and rejects it under an npm pin", async () => {
  const f = await fixture({ flat: true });
  const runtime = f.make();
  await runtime.install(ANTIGRAVITY, signal(), () => {});
  expect(await runtime.installed(ANTIGRAVITY)).toBe(true);
  expect(
    await readFile(
      path.join(path.dirname(runtime.executables[ANTIGRAVITY]), "companion"),
      "utf8",
    ),
  ).toBe("companion resource");

  const npm = f.make({ ...f.artifact, layout: "npm" });
  await expect(npm.install(ANTIGRAVITY, signal(), () => {})).rejects.toThrow(
    "unsupported entries",
  );
  expect(await npm.installed(ANTIGRAVITY)).toBe(false);
});

test("installs a missing provider once and treats a changed manifest as a new target", async () => {
  const f = await fixture();
  const runtime = f.make();
  expect(await runtime.installed(CODEX)).toBe(false);
  expect(f.requested).not.toHaveBeenCalled();
  const report = vi.fn();
  await runtime.install(CODEX, signal(), report);
  expect(await runtime.installed(CODEX)).toBe(true);
  expect(
    await readFile(
      path.join(path.dirname(runtime.executables[CODEX]), "companion"),
      "utf8",
    ),
  ).toBe("companion resource");
  expect(report).toHaveBeenLastCalledWith(
    "Installed. Checking sign-in status…",
  );
  const unchanged = f.make();
  expect(await unchanged.installed(CODEX)).toBe(true);
  await unchanged.install(CODEX, signal(), report);
  expect(f.requested).toHaveBeenCalledOnce();
  // Even a URL-only manifest edit has a new immutable target; no mutable current pointer.
  const changed = f.make({ ...f.artifact, url: f.artifact.url + "?release=2" });
  expect(changed.executables[CODEX]).not.toBe(runtime.executables[CODEX]);
  expect(await changed.installed(CODEX)).toBe(false);
  expect(await changed.installed(CLAUDE_CODE)).toBe(false);
  await changed.install(CODEX, signal(), report);
  expect(await changed.installed(CODEX)).toBe(true);
  expect(await runtime.installed(CODEX)).toBe(true);
  expect(f.requested).toHaveBeenCalledTimes(2);
});

test.each(["checksum", "version", "symlink", "http"] as const)(
  "rejects %s failure without publishing a runtime or leaving temporary files",
  async (failure) => {
    const f = await fixture({
      version: failure === "version" ? "9.9.9" : undefined,
      symlink: failure === "symlink",
      status: failure === "http" ? 503 : undefined,
    });
    const runtime = f.make(
      failure === "checksum"
        ? { ...f.artifact, integrity: "sha512-invalid" }
        : f.artifact,
    );
    await expect(runtime.install(CODEX, signal(), () => {})).rejects.toThrow();
    expect(await runtime.installed(CODEX)).toBe(false);
    expect(await readdir(path.join(f.root, CODEX, "test"))).toEqual([]);
  },
);

test("cancellation waits for network and temporary-file cleanup", async () => {
  const f = await fixture({ slow: true });
  const runtime = f.make();
  const fiber = Effect.runFork(
    installationTask((abort) => runtime.install(CODEX, abort, () => {})),
  );
  await vi.waitFor(() => expect(f.requested).toHaveBeenCalledOnce());
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(await runtime.installed(CODEX)).toBe(false);
  expect(await readdir(path.join(f.root, CODEX, "test"))).toEqual([]);
});

test("incomplete directories remain missing until installation completes", async () => {
  const f = await fixture();
  const runtime = f.make();
  await mkdir(path.dirname(runtime.executables[CODEX]), { recursive: true });
  await writeFile(runtime.executables[CODEX], "partial");
  expect(await runtime.installed(CODEX)).toBe(false);
  await runtime.install(CODEX, signal(), () => {});
  expect(await runtime.installed(CODEX)).toBe(true);
});

test("an architecture change requires installation under the new target", async () => {
  const f = await fixture();
  await f.make().install(CODEX, signal(), () => {});
  const next = createInstallations(
    f.root,
    {
      [CODEX]: { other: f.artifact },
      [CLAUDE_CODE]: { other: f.artifact },
      [ANTIGRAVITY]: { other: f.artifact },
    },
    "other",
  );
  expect(await next.installed(CODEX)).toBe(false);
  expect(await next.installed(CLAUDE_CODE)).toBe(false);
});
