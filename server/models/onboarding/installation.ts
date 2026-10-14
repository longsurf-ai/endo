// Purpose: Downloads, verifies, and atomically installs app-pinned native runtimes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import * as tar from "tar";
import type { NativeProviderID } from "@openchart/models/model-tiers";
import {
  PROVIDER_MANIFEST,
  type RuntimeArtifact,
  type RuntimeManifest,
} from "@openchart/server/models/onboarding/manifest";
import { SetupFailed } from "@openchart/server/models/onboarding/errors";

const execute = promisify(execFile);
const completed = ".installed";

async function exists(filename: string) {
  try {
    await access(filename);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

/**
 * Resolves only app-owned paths. Construction performs no filesystem/network I/O.
 * A completed directory is immutable; its identity includes every manifest field.
 * @example const installations = createInstallations(path.join(home, "model-providers"));
 */
export function createInstallations<Id extends string = NativeProviderID>(
  directory: string,
  // The default serves the model providers; other owners pass their own pins.
  manifest: RuntimeManifest<Id> = PROVIDER_MANIFEST as RuntimeManifest<Id>,
  platform = `${process.platform}-${process.arch}`,
) {
  function target(providerID: Id) {
    const artifact: RuntimeArtifact | undefined =
      manifest[providerID][platform];
    const identity = createHash("sha256")
      .update(JSON.stringify(artifact ?? null))
      .digest("hex");
    const parent = path.join(directory, providerID, platform);
    const root = path.join(parent, identity);
    return {
      artifact,
      identity,
      parent,
      root,
      executable: path.join(root, artifact?.executable ?? "unavailable"),
    };
  }
  const executables = Object.fromEntries(
    (Object.keys(manifest) as Id[]).map((id) => [id, target(id).executable]),
  ) as Record<Id, string>;
  async function installed(providerID: Id) {
    const selected = target(providerID);
    return (
      (await exists(path.join(selected.root, completed))) &&
      (await exists(selected.executable))
    );
  }
  async function install(
    providerID: Id,
    signal: AbortSignal,
    report: (message: string) => void,
  ) {
    const { artifact, identity, parent, root } = target(providerID);
    if (!artifact)
      throw new Error(`Provider downloads are unavailable for ${platform}.`);
    if (await installed(providerID)) return;
    await mkdir(parent, { recursive: true });
    const temporary = await mkdtemp(path.join(parent, ".download-"));
    try {
      const archive = path.join(temporary, "runtime.tgz");
      const payload = path.join(temporary, "payload");
      await mkdir(payload);
      report(`Downloading version ${artifact.version}…`);
      const response = await fetch(artifact.url, { signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Download failed (HTTP ${response.status}).`);
      }
      const hash = createHash("sha512");
      let received = 0;
      let lastMegabyte = -1;
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > 512 * 1024 * 1024)
              return callback(
                new Error("Provider archive exceeds the download limit."),
              );
            hash.update(chunk);
            const megabytes = Math.floor(received / 1024 / 1024);
            if (megabytes !== lastMegabyte) {
              lastMegabyte = megabytes;
              report(
                `Downloading version ${artifact.version}… ${megabytes} MB`,
              );
            }
            callback(null, chunk);
          },
        }),
        createWriteStream(archive, { flags: "wx" }),
        { signal },
      );
      report("Verifying download…");
      if (`sha512-${hash.digest("base64")}` !== artifact.integrity)
        throw new Error(
          "Provider download checksum did not match the app manifest.",
        );
      signal.throwIfAborted();
      // Validate the entire archive before extraction; links and special files are unnecessary in CLI artifacts.
      const npm = artifact.layout === "npm";
      let invalid = false;
      let unpacked = 0;
      await tar.t({
        file: archive,
        strict: true,
        onReadEntry(entry) {
          const parts = entry.path.split("/");
          unpacked += entry.size;
          if (
            (npm && !entry.path.startsWith("package/")) ||
            path.isAbsolute(entry.path) ||
            parts.includes("..") ||
            entry.path.includes("\\") ||
            entry.path.includes(":") ||
            !["File", "Directory"].includes(entry.type) ||
            unpacked > 2 * 1024 * 1024 * 1024
          )
            invalid = true;
        },
      });
      if (invalid)
        throw new Error("Provider archive contains unsupported entries.");
      signal.throwIfAborted();
      report("Installing provider…");
      await tar.x({
        file: archive,
        cwd: payload,
        strip: npm ? 1 : 0,
        strict: true,
        preservePaths: false,
        chmod: true,
      });
      signal.throwIfAborted();
      const binary = path.join(payload, artifact.executable);
      if (!(await stat(binary)).isFile())
        throw new Error("Provider executable is missing from the archive.");
      await chmod(binary, 0o755);
      const { stdout } = await execute(binary, ["--version"], {
        signal,
        timeout: 10_000,
        maxBuffer: 16_384,
        env: {
          ...process.env,
          DISABLE_AUTOUPDATER: "1",
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        },
      });
      // CLIs prefix or suffix their version ("codex-cli 1.2.3", "uv 0.12.0 (…)").
      const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
      if (version !== artifact.version)
        throw new Error(
          `Expected provider version ${artifact.version}, received ${version}.`,
        );
      await writeFile(path.join(payload, completed), identity);
      signal.throwIfAborted();
      // Incomplete/corrupt targets are never usable. Other completed versions remain untouched.
      if ((await exists(root)) && !(await installed(providerID)))
        await rm(root, { recursive: true, force: true });
      try {
        await rename(payload, root);
      } catch (cause) {
        if (!(await installed(providerID))) throw cause;
      }
      report("Installed. Checking sign-in status…");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return { executables, installed, install };
}

/** Installation operations accepted by the onboarding lifecycle. */
export type Installations = ReturnType<
  typeof createInstallations<NativeProviderID>
>;

/**
 * Await Node cleanup on interruption, including streams, child exit, and temp files.
 * @example yield* installationTask(signal => installations.install(id, signal, report));
 */
export function installationTask<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.callback<A, SetupFailed>((resume) => {
    const controller = new AbortController();
    const pending = run(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause) =>
        resume(
          Effect.fail(
            new SetupFailed({
              message:
                cause instanceof Error
                  ? cause.message
                  : "Provider installation failed.",
            }),
          ),
        ),
    );
    return Effect.promise(async () => {
      controller.abort();
      await pending;
    });
  });
}
