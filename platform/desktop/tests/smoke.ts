// Purpose: Verify the packaged app hosts its backend, persists chats, and preserves renderer isolation.
import { CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";

import { createInstallations } from "@openchart/server/models/onboarding/installation";
import { PROVIDER_MANIFEST } from "@openchart/server/models/onboarding/manifest";
import assert from "node:assert/strict";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const sourceExecutable = process.argv[2];
assert(
  sourceExecutable && isAbsolute(sourceExecutable),
  "Supply an absolute Electron executable path",
);
const environment = process.argv[3] ?? "production";
assert(environment === "development" || environment === "production");
const keychain = process.argv[4] ?? "mock";
assert(keychain === "mock" || keychain === "system");
const development = environment === "development";
const artifacts = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  ".artifacts",
);
await mkdir(artifacts, { recursive: true });
// Relocate the whole package outside the checkout so omitted runtime files
// cannot resolve through the repository's ancestor node_modules directories.
const profile = await realpath(
  await mkdtemp(join(tmpdir(), "endo-desktop-smoke-")),
);
const sourceBundle =
  process.platform === "darwin"
    ? dirname(dirname(dirname(sourceExecutable)))
    : dirname(sourceExecutable);
const bundle = join(profile, basename(sourceBundle));
const executable = join(bundle, relative(sourceBundle, sourceExecutable));
const home = join(profile, "home");
const userData = join(profile, "browser");
const errors: string[] = [];
const processErrors: string[] = [];
let application: ElectronApplication | undefined;
let passed = false;
const nativeState = join(profile, "native-state");
const nativeBin = join(profile, "bin");

/** Exercises Settings through the renderer, including native CLI setup and model requests. */
async function verifySettings(page: Page) {
  const filename = join(home, "settings.json");
  await expect
    .poll(
      async () => JSON.parse(await readFile(filename, "utf8")).appearance.theme,
    )
    .toBe("dark");

  const applicationDirectory = await application!.evaluate(({ app }) =>
    app.getAppPath(),
  );
  const siblingReady = application!.waitForEvent("window");
  await application!.evaluate(
    ({ BrowserWindow }, preload) => {
      const sibling = new BrowserWindow({
        show: true,
        webPreferences: {
          preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      void sibling.loadURL("endo://app/app");
    },
    join(applicationDirectory, "preload/preload.cjs"),
  );
  const sibling = await siblingReady;
  sibling.on("pageerror", (cause) => errors.push(cause.message));
  sibling.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  try {
    await sibling.goto("endo://app/app/settings/interface");
    await expect(sibling.locator("html")).toHaveClass(/dark/);
    const saved = JSON.parse(await readFile(filename, "utf8"));
    saved.appearance.theme = "light";
    const replacement = join(home, "settings.next.json");
    await writeFile(replacement, JSON.stringify(saved));
    await rename(replacement, filename);
    await expect(page.locator("html")).toHaveClass(/light/);
    await expect(sibling.locator("html")).toHaveClass(/light/);
  } catch (cause) {
    await writeFile(
      join(artifacts, "desktop-sibling-failure.txt"),
      `${sibling.url()}\n${await sibling.content()}`,
    );
    throw cause;
  } finally {
    await sibling.close();
  }

  await page.getByRole("link", { name: "Models", exact: true }).click();
  for (const name of ["Codex", "Claude Code"]) {
    await expect(page.getByRole("switch", { name, exact: true })).toHaveCount(
      0,
    );
  }
  await page
    .getByRole("button", { name: "Check again", exact: true })
    .first()
    .click();
  await page
    .getByRole("region", { name: "Codex", exact: true })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Authorization code for Codex" })
    .fill("smoke-code");
  await page
    .getByRole("region", { name: "Codex", exact: true })
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Codex", exact: true })
      .getByText("Ready", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Codex", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("region", { name: "Codex", exact: true })
      .getByText("1 models available", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Default model", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "codex / smoke-model",
      exact: true,
    })
    .click();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(filename, "utf8")).models.defaultModel
          ?.modelID,
    )
    .toBe("tier1");
  await page.screenshot({
    path: join(artifacts, "desktop-model-settings.png"),
  });
  await page.goto("endo://app/app");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Reply with CONFIG_NATIVE_OK.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .locator('[data-aui-quote-selectable=""]')
      .getByText("CONFIG_NATIVE_OK", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  assert(
    (await readFile(join(nativeState, "requests"), "utf8")).includes("chat"),
  );
  const sessionId = new URL(page.url()).pathname.split("/").at(-1);
  const currentTitle = await page
    .locator('[data-sidebar="menu-button"][aria-current="page"]')
    .getAttribute("title");
  await page
    .getByRole("button", { name: `Options for ${currentTitle}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const sessionTitle = "Native provider smoke";
  await page
    .getByRole("textbox", { name: "Chat name", exact: true })
    .fill(sessionTitle);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert(sessionId && sessionTitle);
  await page.screenshot({
    path: join(artifacts, "desktop-configured-chat.png"),
  });
  const workspaceRoot = join(home, "workspaces/default");
  assert.deepEqual((await readdir(workspaceRoot)).sort(), ["workflows"]);
  await writeFile(
    join(workspaceRoot, "workspace-smoke.workflow.ts"),
    `
import { defineWorkflow, Schema, agent, textPrompt } from "@openchart/workflow";
export default defineWorkflow({
  description: "Smoke a workspace-authored child agent",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }, { parentPrompt }) => agent(textPrompt("SDK_CHILD:" + question, parentPrompt.model, parentPrompt.agent)),
});`,
  );
  await page.getByRole("button", { name: /^New Chat/ }).click();
  await expect(page).not.toHaveURL(`endo://app/app/sessions/${sessionId}`);
  await expect(
    page.getByRole("heading", { name: "Where should we begin?" }),
  ).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await composer.fill("@workspace-smoke");
  await expect(
    page.getByRole("option", { name: /workspace-smoke.workflow.ts/ }),
  ).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toContainText("workspace-smoke.workflow.ts");
  await composer.press("End");
  await composer.pressSequentially(
    " WORKSPACE_RUN: execute this workflow for the smoke test.",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("main").getByText("WORKSPACE_WORKFLOW_OK", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  const nativeCalls = (await readFile(join(nativeState, "requests"), "utf8"))
    .trim()
    .split("\n");
  const workflowCalls = nativeCalls.filter(
    (call) => call === "workflow",
  ).length;
  const workflowChildren = nativeCalls.filter(
    (call) => call === "child",
  ).length;
  assert.equal(workflowCalls, 1);
  assert.equal(workflowChildren, 1);
  assert.deepEqual((await readdir(workspaceRoot)).sort(), [
    "workflows",
    "workspace-smoke.workflow.ts",
  ]);
  await page.screenshot({
    path: join(artifacts, "desktop-workspace-workflow.png"),
  });
  return {
    sessionId,
    sessionTitle,
    crossWindow: true,
    externalReplacement: true,
    nativeCalls,
    nativeSetup: true,
    workspaceWorkflow: {
      workflowCalls,
      workflowChildren,
      workspaceFiles: await readdir(workspaceRoot),
    },
  };
}

/** Exercises normal Quit, observes backend exit, and then releases Electron. */
async function quit() {
  // Closing the server aborts the renderer's live SSE request by design.
  for (const page of application!.windows()) page.removeAllListeners("console");
  const stopped = await application!.evaluate(({ app }) => {
    const backend = app
      .getAppMetrics()
      .find((metric) => metric.name === "Endo Backend");
    if (!backend) throw new Error("Packaged backend process is missing");
    return new Promise<{ pid: number; elapsed: number }>((resolve, reject) => {
      const start = Date.now();
      let poll: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error("Backend did not exit during Quit"));
      }, 10_000);
      app.on("child-process-gone", (_event, details) => {
        if (details.name === "Endo Backend" && details.reason !== "clean-exit")
          reject(new Error(`Backend exited abnormally: ${details.reason}`));
      });
      // Hold only the final main-process exit until Playwright reads the result.
      app.on("will-quit", function onQuit(event) {
        // Main prevents the first event while it waits for backend cleanup.
        if (event.defaultPrevented) return;
        app.removeListener("will-quit", onQuit);
        event.preventDefault();
        // macOS process reaping can trail Electron's exit event. Observe the OS,
        // not the cached process metrics, while still enforcing the Quit budget.
        poll = setInterval(() => {
          try {
            process.kill(backend.pid, 0);
          } catch (cause) {
            clearInterval(poll);
            clearTimeout(timeout);
            if (
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ESRCH"
            )
              resolve({ pid: backend.pid, elapsed: Date.now() - start });
            else reject(cause);
          }
        }, 10);
      });
      app.quit();
    });
  });
  assert(stopped.elapsed < 5_000, "Backend exceeded the graceful Quit budget");
  await application!.close();
  application = undefined;
  assert.throws(() => process.kill(stopped.pid, 0), { code: "ESRCH" });
  return stopped;
}

/** Starts only the supplied package and observes renderer runtime errors. */
async function launch(): Promise<Page> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.ENDO_DESKTOP_DEV_URL;
  env.PATH = `${nativeBin}:${env.PATH ?? ""}`;
  env.ENDO_SMOKE_STATE = nativeState;
  application = await _electron.launch({
    executablePath: executable,
    cwd: profile,
    args: [
      `--user-data-dir=${userData}`,
      `--endo-home=${home}`,
      ...(process.platform === "darwin" && keychain === "mock"
        ? ["--use-mock-keychain"]
        : []),
    ],
    // Only release builds must ignore a supplied development URL.
    env: development
      ? env
      : { ...env, ENDO_DESKTOP_DEV_URL: "https://untrusted.test" },
    timeout: 30_000,
  });
  application.process().stdout?.on("data", (chunk: Buffer) => {
    processErrors.push(chunk.toString());
  });
  application.process().stderr?.on("data", (chunk: Buffer) => {
    processErrors.push(chunk.toString());
  });
  assert(await application.evaluate(({ app }) => app.isPackaged));
  const appPath = await application.evaluate(({ app }) => app.getAppPath());
  assert.equal(
    appPath,
    join(
      bundle,
      process.platform === "darwin" ? "Contents/Resources" : "resources",
      "app.asar",
    ),
  );
  assert.equal(
    await application.evaluate(({ app }) => app.getName()),
    development ? "Endo Development" : "Endo",
  );
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    userData,
  );
  assert((await readFile(join(home, "openchart.sqlite3"))).byteLength > 0);
  await assert.rejects(readFile(join(userData, "openchart.sqlite3")), {
    code: "ENOENT",
  });
  page.on("pageerror", (cause) => errors.push(cause.stack ?? cause.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 600));
  });
  page.setDefaultTimeout(30_000);
  await expect(page).toHaveURL(/^endo:\/\/app\//);
  return page;
}

/** Checks Mac header spacing and clicks its controls with the sidebar open and closed. */
async function verifyMacHeader(page: Page, route: "chat" | "settings") {
  if (process.platform !== "darwin") return;
  const header = page.locator(".jan-chat-header");
  const sidebarHeader = page.locator(
    '[data-sidebar="header"] > div:first-child',
  );
  const sidebar = page.locator('[data-side="left"][data-state]');
  await expect(header).toHaveCSS("app-region", "drag");
  await expect(sidebarHeader).toHaveCSS("app-region", "drag");
  const collapse = sidebarHeader.getByRole("button", {
    name: "Toggle Sidebar",
  });
  await expect(collapse).toHaveCSS("app-region", "no-drag");
  const expanded = await collapse.boundingBox();
  assert(
    expanded && expanded.x >= 88,
    "Sidebar control overlaps native buttons",
  );
  await collapse.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect.poll(async () => (await header.boundingBox())?.x).toBe(0);
  const expand = header.getByRole("button", { name: "Toggle Sidebar" });
  await expect(expand).toHaveCSS("app-region", "no-drag");
  const collapsed = await header.getByRole("button").first().boundingBox();
  assert(
    collapsed && collapsed.x >= 88,
    "Header control overlaps native buttons",
  );
  await page.screenshot({
    path: join(artifacts, `desktop-${route}-collapsed.png`),
  });
  await expand.click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(collapse).toBeVisible();
  return { expandedControlX: expanded.x, collapsedControlX: collapsed.x };
}

try {
  await cp(sourceBundle, bundle, { recursive: true, verbatimSymlinks: true });
  await mkdir(home, { recursive: true });
  await mkdir(nativeState, { recursive: true });
  await mkdir(nativeBin, { recursive: true });
  const platform = `${process.platform}-${process.arch}`;
  await writeFile(
    join(nativeState, "version"),
    PROVIDER_MANIFEST[CODEX][platform]!.version,
  );
  const fixture = await readFile(
    new URL("./native-cli-fixture.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(
    join(nativeBin, "codex"),
    `#!${process.execPath}\n${fixture}`,
  );
  await chmod(join(nativeBin, "codex"), 0o755);
  // Claude remains explicitly signed out; no real native account is used.
  await writeFile(
    join(nativeBin, "claude"),
    `#!${process.execPath}\nconsole.log(process.argv.includes("--version") ? "${PROVIDER_MANIFEST[CLAUDE_CODE][platform]!.version} (Claude Code)" : JSON.stringify({loggedIn: false}));`,
  );
  await chmod(join(nativeBin, "claude"), 0o755);
  // Seed completed managed fixtures before startup reconciliation can download real CLIs.
  const installations = createInstallations(join(home, "model-providers"));
  for (const [providerID, filename] of [
    [CODEX, "codex"],
    [CLAUDE_CODE, "claude"],
  ] as const) {
    const target = installations.executables[providerID];
    const artifact = PROVIDER_MANIFEST[providerID][platform]!;
    const root = target.slice(0, -artifact.executable.length);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(nativeBin, filename), target);
    await writeFile(join(root, ".installed"), basename(root));
    assert(await installations.installed(providerID));
  }
  await writeFile(join(home, "settings.json"), JSON.stringify({}));
  let page = await launch();

  const onboarding = page.getByRole("dialog", { name: "Connect your agent" });
  await expect(onboarding).toBeVisible();
  for (const name of ["Codex", "Claude Code", "Antigravity", "Grok"])
    await expect(
      onboarding.getByRole("region", { name, exact: true }),
    ).toBeVisible();
  await onboarding
    .getByRole("button", { name: /^(Continue|Skip for now)$/ })
    .click();
  await expect(onboarding).toHaveCount(0);
  await page.reload();

  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Connect your agent" }),
  ).toHaveCount(0);
  // Observe the app's normal discovery request; no prompt or market query is sent.
  // Ignore a late response from the page being replaced by this reload.
  const models = page
    .waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
    })
    .then(() =>
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/trpc/models.list",
      ),
    );
  await page.reload();
  const modelResponse = await models;
  assert.equal(modelResponse.status(), 200);
  assert(Array.isArray((await modelResponse.json()).result.data));
  const windowButtons =
    process.platform === "darwin"
      ? await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
        )
      : undefined;
  if (process.platform === "darwin")
    assert.deepEqual(windowButtons, { x: 20, y: 23 });
  const chatHeader = await verifyMacHeader(page, "chat");

  const sseReady = await page.evaluate(async () => {
    const { origin, token } = await (
      window as unknown as {
        desktop: { connection(): Promise<{ origin: string; token: string }> };
      }
    ).desktop.connection();
    const response = await fetch(`${origin}/trpc/events.subscribe`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.body)
      throw new Error("Packaged SSE connection failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    try {
      while (!frames.includes('"kind":"ready"')) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Packaged SSE closed before ready");
        frames += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    return true;
  });
  assert.equal(sseReady, true);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  const settingsHeader = await verifyMacHeader(page, "settings");
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dark", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Theme", exact: true }),
  ).toHaveText("Dark");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Theme", exact: true }),
  ).toHaveText("Dark");
  await page.screenshot({ path: join(artifacts, "desktop-settings.png") });
  const settings = await verifySettings(page);
  await page.goto("endo://app/app");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(artifacts, "desktop-chat.png") });
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();

  // New Chat opens a fresh draft; the earlier chat remains navigable.
  await page.getByRole("button", { name: /^New Chat/ }).click();
  await expect(page).toHaveURL("endo://app/app");
  const session = settings.sessionId;
  const thread = page.getByRole("button", {
    name: settings.sessionTitle,
    exact: true,
  });
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(page).toHaveURL(`endo://app/app/sessions/${session}`);

  const isolation = await application!.evaluate(({ app, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
    return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed;
  });
  // Electron exposes OS sandbox status on macOS and Windows.
  if (process.platform !== "linux") assert.equal(isolation, true);
  assert.deepEqual(
    await page.evaluate("({require: typeof require, process: typeof process})"),
    {
      require: "undefined",
      process: "undefined",
    },
  );

  const boundary = await application!.evaluate(async ({ net }) => {
    const missing = await net.fetch("endo://app/assets/missing.js");
    const escape = await net.fetch("endo://app/..%2fpackage.json");
    const mockWorker = await net.fetch("endo://app/mockServiceWorker.js");
    const document = await net.fetch("endo://app/app", {
      headers: { accept: "text/html" },
    });
    return {
      missing: missing.status,
      escape: escape.status,
      mockWorker: mockWorker.status,
      csp: document.headers.get("content-security-policy"),
    };
  });
  assert.equal(boundary.missing, 404);
  assert.equal(boundary.escape, 404);
  assert.equal(boundary.mockWorker, 404);
  assert(boundary.csp?.includes("script-src 'self'"));
  assert.match(boundary.csp ?? "", /connect-src [^;]*http:\/\/127\.0\.0\.1:/);

  await page.evaluate(() => window.open("about:blank"));
  assert.equal(
    await application!.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.deepEqual(errors, []);
  const stopped = await quit();

  page = await launch();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Connect your agent" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: settings.sessionTitle, exact: true })
    .click();
  await expect(page).toHaveURL(`endo://app/app/sessions/${session}`);
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Codex", exact: true })
      .getByText("1 models available", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);

  const result = {
    executable: sourceExecutable,
    keychain,
    relocatedBundle: bundle,
    titlebar: { windowButtons, chatHeader, settingsHeader },
    isolation,
    boundary,
    session,
    sseReady,
    stopped,
    settings,
    tests:
      "chat shell, settings, native window buttons, draggable headers, clickable header controls, sidebar collapse/expand spacing, theme persistence, no mock worker, models, SSE ready, hosted backend, new chat, reload, graceful backend exit, restart with persisted chat, renderer isolation",
  };
  await writeFile(
    join(artifacts, "smoke-result.json"),
    JSON.stringify(result, null, 2),
  );
  passed = true;
  console.log("Electron smoke passed:", result);
} catch (cause) {
  console.error("Renderer errors:", errors);
  await writeFile(
    join(artifacts, "desktop-process-failure.txt"),
    processErrors.join(""),
  );
  const page = application?.windows()[0];
  if (page) {
    await Promise.allSettled([
      page.screenshot({ path: join(artifacts, "desktop-failure.png") }),
      page
        .locator("body")
        .innerText()
        .then((text) =>
          writeFile(join(artifacts, "desktop-failure.txt"), text),
        ),
    ]);
  }
  throw cause;
} finally {
  await application?.close();
  if (passed) await rm(profile, { recursive: true, force: true });
  else console.error("Smoke failure profile:", profile);
}
