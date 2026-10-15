// Renders demo/media/star/star-endo.html to demo/media/star-endo.gif.
// Usage from the repository root: node demo/media/star/render.mjs
// Requires installed workspace dependencies, ffmpeg on PATH, and Playwright's Chromium:
// npm --prefix platform/desktop exec -- playwright install chromium --only-shell
// The review contact sheet is written to a new directory under the OS temp directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { chromium } = createRequire(
  path.join(root, "platform/desktop/package.json"),
)("@playwright/test");
const source = path.join(root, "demo/media/star/star-endo.html");
const output = path.join(root, "demo/media/star-endo.gif");
const work = mkdtempSync(path.join(tmpdir(), "endo-readme-star-"));
const frames = path.join(work, "frames");
const contactSheet = path.join(work, "contact-sheet.png");
const [width, height, fps, seconds] = [1000, 420, 20, 7];

mkdirSync(frames);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await page.goto(`${pathToFileURL(source)}?render`);
  await page.evaluate(() => window.ready);
  if (!(await page.evaluate(() => document.fonts.check("600 16px Inter"))))
    throw new Error("Inter did not load");
  for (let index = 0; index < fps * seconds; index++) {
    await page.evaluate((t) => window.renderAt(t), index / fps);
    await page.screenshot({
      path: path.join(frames, `${String(index).padStart(4, "0")}.png`),
    });
  }
} finally {
  await browser.close();
}

const ffmpeg = (...args) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args.map(String)], {
    stdio: "inherit",
  });
ffmpeg(
  "-framerate",
  fps,
  "-i",
  path.join(frames, "%04d.png"),
  "-vf",
  `scale=${width}:${height}:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  "-loop",
  0,
  output,
);
rmSync(frames, { recursive: true });

// Review sheet: wide, zoom-in, click, hold, zoom-out, closing message, and loop reset.
const review = [0, 30, 44, 56, 68, 82, 92, 106, 126, fps * seconds - 1];
ffmpeg(
  "-i",
  output,
  "-vf",
  `select='${review.map((n) => `eq(n,${n})`).join("+")}',scale=${width / 2}:-1,tile=2x5:padding=8:color=white`,
  "-frames:v",
  1,
  contactSheet,
);
console.log(
  `${path.relative(root, output)}: ${statSync(output).size} bytes, ${fps * seconds} frames at ${fps} fps`,
);
console.log(`Contact sheet: ${contactSheet}`);
