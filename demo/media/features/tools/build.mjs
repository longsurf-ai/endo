#!/usr/bin/env node
// Generates <feature>/index.html from <feature>/timing.json: the edited
// recording inside a window frame, with a camera, a cursor and click rings.
// Run tools/remap.mjs first, then `node tools/build.mjs [feature ...]`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES } from "./spec.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const W = 1920;
const H = 1260;
// The window shows the 2560×1680 capture at 0.73125 (logical px × 2).
const WIN = { x: 24, y: 24, w: 1872, h: 1212 };
const K0 = WIN.w / 2560;

const CURSOR = `<svg viewBox="0 0 22 30" width="44" height="60"><path d="M1.5 1.5v21.6l5.4-5.2 3.7 8.5 3.7-1.6-3.6-8.3h7.4Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

const only = process.argv.slice(2);
for (const name of Object.keys(FEATURES)) {
  if (only.length && !only.includes(name)) continue;
  const T = JSON.parse(readFileSync(join(ROOT, name, "timing.json"), "utf8"));
  const D = T.duration;
  const rings = T.clicks.map((_, i) => `<i class="ring" id="ring-${i}"></i>`).join("");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0E0E0E; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #0E0E0E; }
#fx { position: absolute; inset: 0; transform-origin: 50% 60%; }
.winbox { position: absolute; left: ${WIN.x}px; top: ${WIN.y}px; width: ${WIN.w}px; height: ${WIN.h}px;
  border-radius: 28px; overflow: hidden; background: #111111; box-shadow: 0 0 0 2px #1E1E1E; }
#app { position: absolute; left: 0; top: 0; width: 2560px; height: 1680px; transform-origin: 0 0; }
#clip { position: absolute; left: 0; top: 0; width: 2560px; height: 1680px; display: block; }
#cur { position: absolute; left: 0; top: 0; width: 44px; height: 60px; }
#cur-i { position: absolute; left: 0; top: 0; width: 44px; height: 60px; transform-origin: 3px 3px;
  filter: drop-shadow(0 3px 5px rgba(0,0,0,0.45)); }
.ring { position: absolute; left: -36px; top: -36px; width: 72px; height: 72px; border-radius: 50%;
  border: 4px solid rgba(255,255,255,0.85); opacity: 0; }
#fade { position: absolute; inset: 0; background: #0E0E0E; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
      <div id="fx">
        <div class="winbox">
          <div id="app" data-layout-allow-overflow>
            <video id="clip" src="assets/clip.mp4" muted playsinline data-start="0" data-duration="${D}" data-track-index="0"></video>
            ${rings}
            <div id="cur"><div id="cur-i">${CURSOR}</div></div>
          </div>
        </div>
      </div>
      <div id="fade"></div>
    </div>
    <script>
const T = ${JSON.stringify({ D, camera: T.camera, cursor: T.cursor, clicks: T.clicks, relaunch: T.relaunch })};
const WIN = ${JSON.stringify(WIN)};
const K0 = ${K0};
// Logical view (cx, cy, zoom) → #app transform, clamped to the window.
function view(cx, cy, s) {
  const k = K0 * s;
  const x = Math.min(0, Math.max(WIN.w - 2560 * k, WIN.w / 2 - cx * 2 * k));
  const y = Math.min(0, Math.max(WIN.h - 1680 * k, WIN.h / 2 - cy * 2 * k));
  return { x, y, scale: k };
}
const tl = gsap.timeline({ paused: true });
const first = T.camera[0];
tl.fromTo("#app", view(first.cx, first.cy, first.s), { ...view(first.cx, first.cy, first.s), duration: 0.01, immediateRender: true }, 0);
for (const c of T.camera.slice(1)) {
  if (c.d === 0) tl.set("#app", view(c.cx, c.cy, c.s), c.at);
  else tl.to("#app", { ...view(c.cx, c.cy, c.s), duration: c.d, ease: "power2.inOut" }, c.at);
}
const p = (x, y) => ({ x: x * 2 - 3, y: y * 2 - 3 });
const c0 = T.cursor[0];
tl.fromTo("#cur", p(c0.x, c0.y), { ...p(c0.x, c0.y), duration: 0.01, immediateRender: true }, 0);
for (const k of T.cursor.slice(1)) {
  if (k.jump) tl.set("#cur", p(k.x, k.y), k.t);
  else tl.to("#cur", { ...p(k.x, k.y), duration: k.arrive - k.t, ease: "power2.inOut" }, k.t);
}
T.clicks.forEach((c, i) => {
  tl.fromTo("#ring-" + i, { x: c.x * 2, y: c.y * 2, scale: 0.3, opacity: 0.9 },
    { x: c.x * 2, y: c.y * 2, scale: 1, opacity: 0, duration: 0.42, ease: "power2.out", immediateRender: false }, c.t);
  tl.fromTo("#cur-i", { scale: 1 }, { scale: 0.82, duration: 0.07, ease: "power1.out", immediateRender: false }, c.t - 0.02);
  tl.to("#cur-i", { scale: 1, duration: 0.12, ease: "power1.out" }, c.t + 0.05);
});
// Quitting and reopening the app around a cut between recordings.
for (const r of T.relaunch) {
  tl.to("#fx", { scale: 0.9, opacity: 0, duration: 0.28, ease: "power2.in" }, r - 0.3);
  tl.fromTo("#fx", { scale: 0.9, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.42, ease: "power2.out", immediateRender: false }, r + 0.12);
}
// Fade through the background at the loop seam.
tl.fromTo("#fade", { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power1.out" }, 0);
tl.fromTo("#fade", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.in", immediateRender: false }, T.D - 0.3);
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
tl.seek(0);
    </script>
  </body>
</html>
`;
  writeFileSync(join(ROOT, name, "index.html"), html);
  console.log(`${name}/index.html: ${D}s`);
}
