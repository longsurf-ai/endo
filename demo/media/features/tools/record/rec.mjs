// Screencast recorder: frames + a mark/cursor log, all on the page's clock (seconds).
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
export async function recorder(page, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "frames"), { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 840, deviceScaleFactor: 2, mobile: false });
  const frames = [], log = [];
  let n = 0, last = 0;
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = `f${String(n++).padStart(5, "0")}.jpg`;
    writeFileSync(path.join(dir, "frames", file), Buffer.from(data, "base64"));
    last = metadata.timestamp;
    frames.push({ t: metadata.timestamp, file });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  const now = () => Date.now() / 1000;
  const api = {
    cdp,
    async start() {
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2560, maxHeight: 1680, everyNthFrame: 1 });
      await page.waitForTimeout(400);
      api.mark("start");
    },
    mark(name, extra = {}) { log.push({ t: now(), name, ...extra }); },
    // Moves the real mouse (for hover states) and logs the target in CSS px.
    async move(x, y, steps = 12) { api.mark("move", { x, y }); await page.mouse.move(x, y, { steps }); },
    async click(x, y) { await api.move(x, y); await page.waitForTimeout(120); api.mark("click", { x, y }); await page.mouse.click(x, y); },
    async clickLocator(loc, dx = 0.5, dy = 0.5) {
      const b = await loc.boundingBox();
      await api.click(b.x + b.width * dx, b.y + b.height * dy);
      return b;
    },
    async stop() {
      api.mark("end");
      await page.waitForTimeout(300);
      await cdp.send("Page.stopScreencast").catch(() => {});
      writeFileSync(path.join(dir, "log.json"), JSON.stringify({ frames, log }, null, 1));
      console.log("frames", frames.length, "span", (frames.at(-1)?.t - frames[0]?.t).toFixed(1), "s");
    },
  };
  return api;
}
