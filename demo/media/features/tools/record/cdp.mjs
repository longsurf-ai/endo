// Connects to a running Endo window over CDP and runs one recording script:
//   node cdp.mjs recA.mjs <output-dir>
// Start the packaged development app with --remote-debugging-port=9333 first.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../../../../platform/desktop/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().startsWith("endo://")) ?? pages[0];
try {
  const step = await import(pathToFileURL(path.resolve(process.argv[2])).href);
  await step.default({ page, args: process.argv.slice(3) });
} finally {
  await browser.close().catch(() => {});
}
