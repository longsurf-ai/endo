// Purpose: Build the host, backend, preload and shared renderer bundles, run Electron with Vite, and package only generated desktop files.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { notificationSounds } from "@openchart/notification";
import { build, createServer, type Plugin, type Rollup } from "vite";
import { z } from "zod";

import { generateWorkflowTypes } from "@openchart/server/agent/workflow/generate-workflow-types";
import metadata from "@openchart/desktop/package.json" with { type: "json" };
import { rendererConfig } from "./renderer-config.ts";

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve("@openchart/desktop/package.json"));
const appDirectory = dirname(require.resolve("@openchart/app/package.json"));
const serverDirectory = dirname(require.resolve("@openchart/server"));
const staging = join(directory, "dist");
const nodeExternal = [/^node:/, ...builtinModules, "electron"];
const runtimePackages = ["@anthropic-ai/claude-agent-sdk", "typescript"];

async function main() {
  const command = z.enum(["dev", "build", "package"]).parse(process.argv[2]);
  const environment = z
    .enum(["development", "production"])
    .parse(
      command === "dev" ? "development" : (process.argv[3] ?? "production"),
    );
  const development = environment === "development";
  process.env.NODE_ENV = development ? "development" : "production";
  await buildDesktopRuntime(development);
  // Tailwind's content paths are relative to the shared app's directory.
  process.chdir(appDirectory);
  if (command === "dev") return runDevelopment();
  await buildRenderer();
  if (command === "package") await packageApplication(development);
}

async function buildDesktopRuntime(development: boolean) {
  await rm(staging, { recursive: true, force: true });
  await buildMain(development);
  await buildBackend();
  await buildPreload();
  // Every command produces a self-contained runtime, including desktop-build.
  await copyRuntimePackages();
  await mkdir(staging, { recursive: true });
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(
      {
        name: "reagent-desktop",
        productName: "Reagent",
        version: metadata.version,
        type: "module",
        main: "main/main.js",
      },
      null,
      2,
    ),
  );
}

async function buildMain(development: boolean) {
  await build({
    configFile: false,
    define: {
      "process.env.REAGENT_DESKTOP_BUILD": JSON.stringify(
        development ? "development" : "production",
      ),
    },
    build: {
      target: "node24",
      outDir: join(staging, "main"),
      emptyOutDir: true,
      lib: {
        entry: join(directory, "src/main.ts"),
        formats: ["es"],
        fileName: () => "main.js",
      },
      rollupOptions: { external: nodeExternal, onwarn },
    },
  });
}

async function buildBackend() {
  // The backend runs the whole server in one Node bundle; only packages that
  // resolve files or binaries at runtime stay external and ship in node_modules.
  const serverTextAssets: Plugin = {
    name: "server-text-assets",
    async buildStart() {
      const declarations = await generateWorkflowTypes();
      for (const file of declarations.watchFiles) this.addWatchFile(file);
      for (const { fileName, content } of declarations.files)
        this.emitFile({
          type: "asset",
          fileName: `.artifacts/workflow-types/${fileName}`,
          source: content,
        });
      for await (const file of glob("agent/workflow/templates/*.workflow.ts", {
        cwd: serverDirectory,
      }))
        this.emitFile({
          type: "asset",
          fileName: `templates/${basename(file)}`,
          source: await readFile(join(serverDirectory, file)),
        });
      // Prompt segments are read beside the compiled module with import.meta.url.
      for await (const file of glob("agent/**/*.txt", { cwd: serverDirectory }))
        this.emitFile({
          type: "asset",
          fileName: basename(file),
          source: await readFile(join(serverDirectory, file)),
        });
    },
  };
  await build({
    configFile: false,
    plugins: [serverTextAssets],
    resolve: { conditions: ["node"] },
    ssr: { noExternal: true },
    build: {
      target: "node24",
      outDir: join(staging, "main"),
      emptyOutDir: false,
      ssr: join(directory, "src/backend-entry.ts"),
      ssrEmitAssets: true,
      rollupOptions: {
        onwarn,
        external: [...nodeExternal, ...runtimePackages],
        output: {
          format: "es",
          entryFileNames: "backend.js",
          // One file: migrations and other lazy imports need no sibling chunks.
          inlineDynamicImports: true,
        },
      },
    },
  });
}

async function buildPreload() {
  await build({
    configFile: false,
    build: {
      target: "node24",
      outDir: join(staging, "preload"),
      emptyOutDir: true,
      lib: {
        entry: join(directory, "src/preload.ts"),
        // Sandboxed preloads must be CommonJS.
        formats: ["cjs"],
        fileName: () => "preload.cjs",
      },
      rollupOptions: { external: ["electron"], onwarn },
    },
  });
}

async function runDevelopment() {
  const vite = await createServer({
    ...rendererConfig(),
    // Vite 5 treats port 0 as its shared 5173 default, not an ephemeral port.
    server: { host: "127.0.0.1", port: 43875, strictPort: false, open: false },
  });
  try {
    await vite.listen();
    vite.printUrls();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Vite did not bind a TCP port");
    const { executable, args } = await prepareDevelopmentHost();
    await runElectron(executable, args, `http://127.0.0.1:${address.port}`);
  } finally {
    await vite.close();
  }
}

async function prepareDevelopmentHost() {
  // Keep the singleton, browser storage and application home local to this
  // checkout and outside rebuilt bundles on every OS.
  const profile = join(directory, ".artifacts/dev-profile");
  const args = [
    `--user-data-dir=${profile}`,
    `--reagent-home=${join(profile, "home")}`,
  ];
  console.log("Desktop development profile:", profile);
  const executable = await packageApplication(true);
  // This development-only profile never contains real-Keychain ciphertext.
  if (process.platform === "darwin") args.unshift("--use-mock-keychain");
  return { executable, args };
}

async function runElectron(executable: string, args: string[], devUrl: string) {
  const env = { ...process.env };
  // Editors built with Electron can export this flag to their terminals.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const child = spawn(executable, args, {
    // Repackaging replaces the app bundle; native providers need a surviving cwd.
    cwd: directory,
    stdio: "inherit",
    env: {
      ...env,
      REAGENT_DESKTOP_DEV_URL: devUrl,
    },
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const [code] = await once(child, "exit");
  process.exitCode = typeof code === "number" ? code : 1;
}

async function buildRenderer() {
  await build({
    ...rendererConfig(),
    build: {
      outDir: join(staging, "renderer"),
      emptyOutDir: true,
      // Gzip sizes mean nothing for a packaged app and cost heap after the
      // bundle is written. Bundling itself needs more than Node's default
      // heap (about 5.7 GB RSS), so package.json runs build, package and
      // release with --max-old-space-size=8192.
      reportCompressedSize: false,
      rollupOptions: { onwarn },
    },
  });
}

async function packageApplication(development: boolean) {
  const name = development ? "Reagent Development" : "Reagent";
  // Production signing and notarization are opt-in; without them macOS builds
  // are ad-hoc signed and run only on this computer.
  const signingIdentity = development
    ? "-"
    : (process.env.REAGENT_SIGNING_IDENTITY ?? "-");
  const notaryProfile = development
    ? undefined
    : process.env.REAGENT_NOTARY_PROFILE;
  // @agent invariant: Development and release execute the same packaged runtime
  // layout on every platform. Only app identity and output location vary here.
  const [bundle] = await packager({
    dir: staging,
    // Packager clears its temporary root; isolate worktrees and release versions.
    tmpdir: join(
      directory,
      ".artifacts/packager",
      development ? "development" : metadata.version,
    ),
    out: join(
      directory,
      development ? ".artifacts/dev" : `out/${metadata.version}`,
    ),
    name,
    icon:
      process.platform === "darwin"
        ? join(directory, "assets/icon.icns")
        : undefined,
    appBundleId: development
      ? "ai.longsurf.reagent.development"
      : "ai.longsurf.reagent",
    electronVersion: metadata.devDependencies.electron,
    asar: true,
    // UNNotificationSound searches the main bundle, not Electron's ASAR archive.
    extraResource: notificationSounds.map((sound) => fileURLToPath(sound.url)),
    osxSign:
      process.platform === "darwin"
        ? {
            identity: signingIdentity,
            identityValidation: signingIdentity !== "-",
            preAutoEntitlements: false,
            continueOnError: false,
            optionsForFile: (file) =>
              file.endsWith(".app")
                ? {
                    entitlements: [
                      "com.apple.security.cs.allow-jit",
                      // Ad-hoc apps cannot match their frameworks' Team ID.
                      ...(signingIdentity === "-"
                        ? ["com.apple.security.cs.disable-library-validation"]
                        : []),
                    ],
                  }
                : {},
          }
        : undefined,
    osxNotarize:
      process.platform === "darwin" && notaryProfile
        ? { keychainProfile: notaryProfile }
        : undefined,
    prune: false,
    overwrite: true,
  });
  if (!bundle) throw new Error("Electron Packager produced no application");
  console.log("Packaged Reagent:", bundle);
  return process.platform === "darwin"
    ? join(bundle, `${name}.app`, "Contents/MacOS", name)
    : join(bundle, `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

async function copyRuntimePackages() {
  const copied = new Set<string>();
  async function copyPackage(name: string, parent: string) {
    if (copied.has(name)) return;
    let source = dirname(createRequire(parent).resolve(name));
    while (!existsSync(join(source, "package.json"))) source = dirname(source);
    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()).optional(),
      })
      .parse(JSON.parse(await readFile(join(source, "package.json"), "utf8")));
    await cp(source, join(staging, "node_modules", name), {
      recursive: true,
      dereference: true,
      filter: (filename) =>
        !filename.slice(source.length).split(/[/\\]/).includes("node_modules"),
    });
    copied.add(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyPackage(dependency, join(source, "package.json"));
  }
  for (const name of runtimePackages) await copyPackage(name, import.meta.url);
}

const onwarn: Rollup.WarningHandlerWithDefault = (warning, warn) => {
  // Zod's explanatory comments mention PURE annotations as prose.
  if (
    warning.code === "INVALID_ANNOTATION" &&
    /[/\\]node_modules[/\\]zod[/\\]v4[/\\]core[/\\](util|regexes)\.js$/.test(
      warning.id ?? "",
    )
  )
    return;
  warn(warning);
};

await main();
