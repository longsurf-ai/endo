#!/usr/bin/env node
// Cuts the raw recordings into one 30 fps clip per feature and resolves the
// cursor and camera keys to output time. Usage:
//   node tools/remap.mjs <recordings-dir> [feature ...]
// <recordings-dir>/<REC>/log.json lists screencast frames and input marks on
// one clock; frames live in <REC>/frames. Writes <feature>/assets/clip.mp4
// and <feature>/timing.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES } from "./spec.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FPS = 30;
const [recRoot, ...only] = process.argv.slice(2);
if (!recRoot) throw new Error("Usage: node tools/remap.mjs <recordings-dir> [feature ...]");

const recordings = new Map();
function recording(name) {
  if (!recordings.has(name)) {
    const { frames, log } = JSON.parse(readFileSync(join(recRoot, name, "log.json"), "utf8"));
    const t0 = log[0].t;
    recordings.set(name, {
      dir: join(recRoot, name, "frames"),
      frames: frames.map((f) => ({ t: f.t - t0, file: f.file })),
      marks: log.map((m) => ({ ...m, t: m.t - t0 })),
    });
  }
  return recordings.get(name);
}

function frameAt(rec, t) {
  const { frames } = recording(rec);
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return join(recording(rec).dir, frames[lo].file);
}

for (const [name, spec] of Object.entries(FEATURES)) {
  if (only.length && !only.includes(name)) continue;
  // Output start of each segment.
  let acc = 0;
  const segs = spec.segments.map(([rec, from, to, speed]) => {
    const seg = { rec, from, to, speed, start: acc, end: acc + (to - from) / speed };
    acc = seg.end;
    return seg;
  });
  const duration = Math.round(acc * FPS) / FPS;
  // Source time → output time; skipped source time maps to the next kept frame.
  const out = (rec, t) => {
    for (const s of segs) {
      if (s.rec !== rec) continue;
      if (t < s.from) return s.start;
      if (t <= s.to) return s.start + (t - s.from) / s.speed;
    }
    return segs.filter((s) => s.rec === rec).at(-1).end;
  };
  const resolve = (at) => {
    if (typeof at === "number") return at;
    const [rec, t] = at.split("@");
    return out(rec, Number(t));
  };

  // Frame list, merged into a concat script with per-frame durations.
  const picks = [];
  for (let k = 0; k < Math.round(duration * FPS); k++) {
    const t = (k + 0.5) / FPS;
    const s = segs.find((x) => t < x.end) ?? segs.at(-1);
    picks.push(frameAt(s.rec, s.from + (t - s.start) * s.speed));
  }
  const lines = [];
  for (let i = 0; i < picks.length; ) {
    let j = i;
    while (j < picks.length && picks[j] === picks[i]) j++;
    lines.push(`file '${picks[i]}'`, `duration ${((j - i) / FPS).toFixed(6)}`);
    i = j;
  }
  lines.push(`file '${picks.at(-1)}'`);
  const list = join(tmpdir(), `endo-feature-${name}.txt`);
  writeFileSync(list, lines.join("\n") + "\n");
  mkdirSync(join(ROOT, name, "assets"), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `scale=1920:1260:flags=lanczos,fps=${FPS},format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart",
    "-t", duration.toFixed(3), join(ROOT, name, "assets", "clip.mp4"),
  ]);

  // Cursor waypoints in output time and logical pixels.
  const cursor = [];
  const clicks = [];
  let prevRec = null;
  const lastByRec = {};
  for (const s of segs) {
    const { marks } = recording(s.rec);
    if (s.rec !== prevRec) {
      const pos = lastByRec[s.rec] ?? spec.cursorStart?.[s.rec] ?? [640, 420];
      cursor.push({ t: s.start, x: pos[0], y: pos[1], jump: true });
    }
    prevRec = s.rec;
    const events = marks.filter((m) => m.x !== undefined && m.t < s.to && m.t >= (s.prevTo ?? -1));
    for (const [i, m] of events.entries()) {
      if (m.t < s.from && m.name !== "move") continue;
      const t = Math.max(s.start, out(s.rec, m.t));
      if (m.name === "click") {
        clicks.push({ t, x: m.x, y: m.y });
        continue;
      }
      if (m.name !== "move") continue;
      const next = events.slice(i + 1).find((e) => e.name === "click" || e.name === "move");
      const nextT = next ? Math.max(s.start, out(s.rec, next.t)) : s.end;
      const arrive = Math.min(Math.max(t + 0.22, out(s.rec, m.t + 0.2)), nextT - 0.02);
      cursor.push({ t, x: m.x, y: m.y, arrive: Math.max(arrive, t + 0.02) });
      lastByRec[s.rec] = [m.x, m.y];
    }
    // Later segments of this recording resume after this one.
    for (const later of segs) if (later.rec === s.rec && later.start > s.start && later.prevTo === undefined) later.prevTo = s.to;
  }

  const camera = spec.camera.map((c) => ({ ...c, at: resolve(c.at), d: c.d ?? 0.5 }));
  const relaunch = (spec.relaunch ?? []).map(resolve);
  writeFileSync(
    join(ROOT, name, "timing.json"),
    JSON.stringify({ duration, segments: segs.map(({ prevTo, ...s }) => s), camera, cursor, clicks, relaunch }, null, 1),
  );
  console.log(`${name}: ${duration.toFixed(2)}s, ${cursor.length} cursor keys, ${clicks.length} clicks`);
}
