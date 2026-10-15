#!/usr/bin/env node
// Generates index.html: a README loop that stays mostly inside Endo. It
// opens the model dropdown to show every agent, starts /best-of-n from the
// composer, flashes through imagined multi-vendor workflows, then returns to
// the thread where the Workflow card completes and the answer streams in.
// Edit and rerun: `node tools/build.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------ logos
const svgInner = (file) =>
  readFileSync(join(ROOT, "assets", file), "utf8")
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
const LOGO = {
  codex: { box: "0 0 256 260", inner: `<g fill="#F2F2F2">${svgInner("logo-codex.svg")}</g>` },
  claude: { box: "0 0 256 257", inner: svgInner("logo-claude.svg") },
  ag: { box: "0 0 24 24", inner: svgInner("logo-antigravity.svg") },
};
let agCount = 0;
function logo(vendor, size, cls = "logo") {
  let inner = LOGO[vendor].inner;
  // Each inline copy of the Antigravity mark needs its own mask/filter ids.
  if (vendor === "ag") inner = inner.replace(/\bag-(\d+)/g, `agm${++agCount}-$1`);
  return `<svg class="${cls}" viewBox="${LOGO[vendor].box}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

// Lucide icons used by the app (24px grid).
const ic = (body, sw = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  plus: ic(`<path d="M5 12h14"/><path d="M12 5v14"/>`),
  chevronDown: ic(`<path d="m6 9 6 6 6-6"/>`),
  briefcase: ic(`<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>`),
  arrowUp: ic(`<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`, 2.4),
  stop: `<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`,
  check: ic(`<path d="M20 6 9 17l-5-5"/>`),
  workflow: ic(`<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>`),
  minimize: ic(`<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>`),
  copy: ic(`<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`, 1.8),
  branch: ic(`<path d="M3 12h7l5-6h5"/><path d="m17 3 3 3-3 3"/><path d="M10 12l5 6h5"/><path d="m17 15 3 3-3 3"/>`, 1.8),
};
const icon = (name, size, cls = "ico") =>
  `<span class="${cls}" style="width:${size}px;height:${size}px">${ICON[name]}</span>`;

// -------------------------------------------------------------- app layer
// App geometry is in capture pixels: home.jpg is a 2560x1680 (2x) capture of
// the 1280x840 window. #app-inner shows it at the window's width with the top
// 16px cropped; the camera (#app) zooms and pans over it.
const WIN = { x: 24, y: 24, w: 1872, h: 1032 };
const SHOT = WIN.w / 2560;
const CROP = 16;

// Measured from home.jpg.
const COMPOSER = { x: 751, y: 670, w: 1538, h: 192 };
const TRIGGER = { x: 846, y: 776, w: 360, h: 60 };
// Thread layout, matching the column of workflow-trace-full.jpg.
const COL = { x: 740, w: 1536 };
const THREAD_COMPOSER_Y = 1220;
const CARD = { y: 290, h0: 374, h1: 545 };

// Model names as the provider catalogs report them (see common/models tests).
const MODELS = [
  ["codex", "GPT-6-Astra", "Codex"],
  ["codex", "GPT-6-Sol", "Codex"],
  ["codex", "GPT-6-Terra", "Codex"],
  ["codex", "GPT-6-Luna", "Codex"],
  ["claude", "Fable 5.1", "Claude Code"],
  ["claude", "Opus 5.5", "Claude Code"],
  ["claude", "Sonnet 5.5", "Claude Code"],
  ["ag", "Gemini 3.1 Pro (High)", "Antigravity"],
  ["ag", "Gemini 3.8 Flash (High)", "Antigravity"],
];
const ITEM_H = 104;
// Slash commands from server/agent/command/catalog.ts, in catalog order.
const COMMANDS = [
  { name: "compact", icon: "minimize", desc: "Summarize this conversation to free up context" },
  {
    name: "best-of-n",
    desc: "Research with n independent agents, then synthesize their answers",
    hint: "Usage: <count> <question>. Count must be a positive integer. Example: 3 Research Google.",
  },
  {
    name: "multi-turn-debate",
    desc: "Debate any topic from affirmative and negative perspectives using your selected model, then summarize every round",
    hint: "Usage: <round> <topic>. Round count must be a positive integer. Example: 3 Should public transit be free?",
  },
  {
    name: "thesis-killer",
    desc: "Challenge up to five critical assumptions and identify what would invalidate your thesis",
    hint: "Usage: <thesis>. Example: Remote work improves team productivity over three years.",
  },
  {
    name: "hypothesis-race",
    desc: "Compare up to five explanations and investigate the question that best distinguishes them",
    hint: "Usage: <question>. Example: Why did signups drop after the redesign?",
  },
];
const PROMPT = "3 How should we price a developer tool?";
const ANSWER = {
  title: "Charge per seat, keep a free tier",
  lines: [
    "All three researchers agree: keep a generous free tier for individual developers,",
    "charge per seat once a team shares projects, and add usage-based pricing only for",
    "heavy automation. They differ on trial length, so test 14 against 30 days.",
  ],
};

// Workflow card rows (best-of-n: Research in parallel, then Synthesis).
const AXIS = { x0: 1079, x1: 2120, total: 41 };
const ax = (t) => AXIS.x0 + ((AXIS.x1 - AXIS.x0) * t) / AXIS.total;
const PHASES = [
  { id: "ph1", name: "Research", y: 118, dur: "34s", calls: 3 },
  { id: "ph2", name: "Synthesis", y: 396, dur: "7s", calls: 1 },
];
const ROWS = [
  { id: "par", label: "parallel", indent: 0, y: 201, from: 0, to: 34, kind: "par" },
  { id: "r1", label: "researcher 1", indent: 1, y: 242, from: 0.3, to: 31 },
  { id: "r2", label: "researcher 2", indent: 1, y: 283, from: 0.4, to: 34 },
  { id: "r3", label: "researcher 3", indent: 1, y: 324, from: 0.3, to: 27 },
  { id: "sum", label: "summarizer", indent: 0, y: 479, from: 34, to: 41 },
];

const chars = (text, cls) =>
  [...text].map((c) => `<span class="${cls}">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("");

function composerHtml() {
  const c = COMPOSER;
  const items = MODELS.map(
    ([v, name, provider], i) => `<div class="mi" style="top:${8 + i * ITEM_H}px">
              <span class="mi-logo">${logo(v, 28)}</span>
              <span class="mi-text"><b>${esc(name)}</b><small>${provider}</small></span>
              ${i === 0 ? icon("check", 32, "mi-check") : ""}
            </div>`,
  ).join("");
  const menu = (id, list) => {
    const rows = list
      .map(
        (cmd, i) => `<div class="si${i === 0 ? " on" : ""}">
              ${icon(cmd.icon ?? "workflow", 28, "si-ico")}
              <span class="si-text"><span class="si-top"><b>/${cmd.name}</b><small>${esc(cmd.desc)}</small></span>${cmd.hint ? `<span class="si-hint">${esc(cmd.hint)}</span>` : ""}</span>
              ${i === 0 ? `<kbd>↵</kbd>` : ""}
            </div>`,
      )
      .join("");
    return `<div id="${id}" class="slash">${rows}</div>`;
  };
  return `
        <div id="slash-all-w" class="slash-w">${menu("slash-all", COMMANDS)}</div>
        <div id="slash-b-w" class="slash-w">${menu("slash-b", [COMMANDS[1], COMMANDS[2]])}</div>
        <div id="slash-be-w" class="slash-w">${menu("slash-be", [COMMANDS[1]])}</div>
        <div id="composer" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px">
          <div class="in-line">
            <span id="ph">Ask anything, or @ a workspace file</span>
            <span id="ty-slash">${chars("/be", "ch")}</span>
            <span id="ty-cmd"><span id="cmd-chip" class="chip">${icon("workflow", 30)}best-of-n</span>${chars(PROMPT, "ch")}</span>
          </div>
          <div class="foot">
            ${icon("plus", 34, "ico f-plus")}
            <span id="trig-bg"></span>
            <span class="f-model">${logo("codex", 30)}<b>GPT-6-Astra</b><i>Default</i>${icon("chevronDown", 30, "ico f-chev")}</span>
            <span class="f-ws">${icon("briefcase", 30)}<b>default</b>${icon("chevronDown", 30, "ico f-chev")}</span>
            <span id="send-off" class="send">${icon("arrowUp", 38)}</span>
            <span id="send-on" class="send on">${icon("arrowUp", 38)}</span>
            <span id="send-stop" class="send on">${icon("stop", 40)}</span>
          </div>
        </div>
        <div id="dropdown" style="left:${TRIGGER.x}px;top:${TRIGGER.y + TRIGGER.h + 12}px">
          <div class="dd-list"><div id="dd-scroll"><span id="dd-hl"></span>${items}</div></div>
          <div class="dd-effort"><small>Thinking</small><span><i class="on">Default</i><i>low</i><i>medium</i><i>high</i></span></div>
        </div>`;
}

function cardHtml() {
  const L = COL.x;
  const phases = PHASES.map(
    (p) => `<div id="${p.id}" class="ph" style="top:${p.y - 22}px">
            ${icon("chevronDown", 28, "ico ph-chev")}<b>${p.name}</b>
            <span class="ph-st"><span id="${p.id}-run">Running&nbsp;&nbsp;0/${p.calls} calls completed</span><span id="${p.id}-done">Completed&nbsp;&nbsp;${p.calls}/${p.calls} calls completed</span></span>
            <span id="${p.id}-dur" class="mono ph-dur">${p.dur}</span>
          </div>`,
  ).join("");
  const rows = ROWS.map(
    (r) => `<div id="row-${r.id}" class="row" style="top:${r.y - 16}px">
            <span class="row-l" style="left:${83 + r.indent * 48}px">${r.label}</span>
            <span id="bar-${r.id}" class="bar ${r.kind ?? "agent"}" style="left:${ax(r.from) - L}px;width:${ax(r.to) - ax(r.from)}px"></span>
            <span id="rd-${r.id}" class="mono row-d">${r.to - Math.round(r.from)}s</span>
          </div>`,
  ).join("");
  return `<div id="card" style="left:${L}px;top:${CARD.y}px;width:${COL.w}px">
          <svg class="card-bg" width="${COL.w}" height="${CARD.h1}"><rect id="card-r" x="1" y="1" width="${COL.w - 2}" height="${CARD.h0}" rx="24"/></svg>
          <div class="card-h"><b>Workflow</b><span id="wf-total" class="mono">0s</span></div>
          ${phases}${rows}
        </div>`;
}

function threadHtml() {
  const lines = ANSWER.lines
    .map((l, i) => `<span id="ans-${i}" class="ans-l" style="top:${654 + i * 48}px">${esc(l)}</span>`)
    .join("");
  return `
        <div id="main-cover"></div>
        <div id="side-row"><span>How should we price a d…</span></div>
        <div id="bubble"><span class="chip light">${icon("workflow", 30)}best-of-n</span>${esc(PROMPT)}</div>
        <div id="working"><span id="wk-run">Working${icon("chevronDown", 28, "ico wk-chev")}</span><span id="wk-done">Worked for 41s${icon("chevronDown", 28, "ico wk-chev")}</span></div>
        ${cardHtml()}
        <div id="answer" style="left:${COL.x}px;top:${CARD.y}px;width:${COL.w}px">
          <h3 id="ans-h">${esc(ANSWER.title)}</h3>
          ${lines}
          <span id="ans-act">${icon("copy", 34)}${icon("branch", 34)}</span>
        </div>`;
}

const CURSOR = `<svg viewBox="0 0 28 28" width="56" height="56"><path d="M5 3l17 9.5-7.3 1.6-3.6 6.8z" fill="#F4F2EE" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------- imagined workflows
// World coordinates equal the screen at scale 1.
const HALF = { tile: [84, 84], doc: [60, 75], clock: [75, 75] };
const GAP = 10;
const P = {
  s3: { codex: [645, 560], claude: [960, 560], ag: [1275, 560], in: [330, 560], out: [1590, 560] },
  s4: { codex: [960, 300], claude: [960, 560], ag: [960, 820], in: [560, 560], out: [1360, 560] },
  s5: { codex: [960, 370], claude: [1150, 710], ag: [770, 710], in: [420, 560], out: [1500, 560] },
};
// The large graph wraps the loop; these nodes sit outside the frame until the
// camera pulls back.
const BIG = {
  clock: { kind: "clock", at: [-420, 560] },
  b1: { kind: "tile", vendor: "codex", at: [0, 180] },
  b2: { kind: "tile", vendor: "claude", at: [0, 560] },
  b3: { kind: "tile", vendor: "ag", at: [0, 940] },
  u1: { kind: "tile", vendor: "ag", at: [560, -110] },
  u2: { kind: "tile", vendor: "claude", at: [1320, -110] },
  l1: { kind: "tile", vendor: "claude", at: [560, 1230] },
  l2: { kind: "tile", vendor: "codex", at: [1320, 1230] },
  d1: { kind: "tile", vendor: "codex", at: [1880, 300] },
  d2: { kind: "tile", vendor: "ag", at: [1880, 820] },
  f: { kind: "doc", at: [2260, 560], badge: true },
};
const NODES = [
  { id: "codex", kind: "tile", vendor: "codex", base: P.s4.codex },
  { id: "claude", kind: "tile", vendor: "claude", base: P.s4.claude },
  { id: "ag", kind: "tile", vendor: "ag", base: P.s4.ag },
  { id: "in", kind: "doc", base: P.s4.in, lines: "prompt" },
  { id: "out", kind: "doc", base: P.s4.out, badge: true },
  ...Object.entries(BIG).map(([id, n]) => ({ id, ...n, base: n.at })),
];
const KIND = Object.fromEntries(NODES.map((n) => [n.id, n.kind]));

function anchor(id, pos, side) {
  const [hw, hh] = HALF[KIND[id]];
  const [x, y] = pos;
  return {
    left: [x - hw - GAP, y],
    right: [x + hw + GAP, y],
    top: [x, y - hh - GAP],
    bottom: [x, y + hh + GAP],
  }[side];
}

const EDGES = [];
const r1 = (n) => Math.round(n * 10) / 10;
function addEdge(id, pts) {
  // pts: 3 points (quadratic) or 4 points (cubic); length by sampling.
  const at = (t) => {
    const u = 1 - t;
    if (pts.length === 3) {
      const [a, c, b] = pts;
      return [0, 1].map((k) => u * u * a[k] + 2 * u * t * c[k] + t * t * b[k]);
    }
    const [a, c1, c2, b] = pts;
    return [0, 1].map(
      (k) => u * u * u * a[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * b[k],
    );
  };
  let len = 0;
  let prev = at(0);
  for (let i = 1; i <= 400; i++) {
    const p = at(i / 400);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  const f = (p) => `${r1(p[0])},${r1(p[1])}`;
  const d =
    pts.length === 3
      ? `M${f(pts[0])} Q${f(pts[1])} ${f(pts[2])}`
      : `M${f(pts[0])} C${f(pts[1])} ${f(pts[2])} ${f(pts[3])}`;
  EDGES.push({ id, d, len: Math.round(len) });
}
// Horizontal-tangent cubic from a's right side to b's left side.
function link(id, a, b, layout) {
  const pa = layout[a] ?? BIG[a].at;
  const pb = layout[b] ?? BIG[b].at;
  const s = anchor(a, pa, "right");
  const e = anchor(b, pb, "left");
  const k = Math.max(50, (e[0] - s[0]) * 0.5);
  addEdge(id, [s, [s[0] + k, s[1]], [e[0] - k, e[1]], e]);
}

const S3 = P.s3;
link("e3a", "in", "codex", S3);
link("e3b", "codex", "claude", S3);
link("e3c", "claude", "ag", S3);
link("e3d", "ag", "out", S3);
const S4 = P.s4;
for (const t of ["codex", "claude", "ag"]) {
  link(`e4i-${t}`, "in", t, S4);
  link(`e4o-${t}`, t, "out", S4);
}
const S5 = P.s5;
link("e5a", "in", "ag", S5);
addEdge("e5b", [anchor("ag", S5.ag, "top"), [S5.ag[0], S5.codex[1]], anchor("codex", S5.codex, "left")]);
addEdge("e5c", [anchor("codex", S5.codex, "right"), [S5.claude[0], S5.codex[1]], anchor("claude", S5.claude, "top")]);
addEdge("e5d", [anchor("claude", S5.claude, "bottom"), [960, 990], anchor("ag", S5.ag, "bottom")]);
link("e5e", "claude", "out", S5);
for (const b of ["b1", "b2", "b3"]) {
  link(`e6c-${b}`, "clock", b, S5);
  link(`e6${b}-in`, b, "in", S5);
}
link("e6b1-u1", "b1", "u1", S5);
link("e6u1-u2", "u1", "u2", S5);
link("e6u2-d1", "u2", "d1", S5);
link("e6b3-l1", "b3", "l1", S5);
link("e6l1-l2", "l1", "l2", S5);
link("e6l2-d2", "l2", "d2", S5);
link("e6out-d1", "out", "d1", S5);
link("e6out-d2", "out", "d2", S5);
link("e6d1-f", "d1", "f", S5);
link("e6d2-f", "d2", "f", S5);

const COMET = 54;
const edgeSvg = [
  ...EDGES.map(
    (e) =>
      `<path id="${e.id}-b" class="eb" d="${e.d}" style="stroke-dasharray:${e.len} ${e.len + 20};stroke-dashoffset:${e.len}"/>`,
  ),
  ...EDGES.map(
    (e) =>
      `<path id="${e.id}-t" class="et" d="${e.d}" style="stroke-dasharray:${e.len} ${e.len + 20};stroke-dashoffset:${e.len}"/>`,
  ),
  ...EDGES.map(
    (e) =>
      `<path id="${e.id}-c" class="ec" d="${e.d}" data-len="${e.len}" style="stroke-dasharray:${COMET} ${e.len + COMET + 40};stroke-dashoffset:${COMET + 6}"/>`,
  ),
].join("\n        ");

const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 12.5 4.2 4.2 8.8-9.4"/></svg>`;
const DOC_LINES = [78, 62, 72, 44];
function nodeHtml(n) {
  const [hw, hh] = HALF[n.kind];
  const style = `left:${n.base[0] - hw}px;top:${n.base[1] - hh}px`;
  if (n.kind === "tile") {
    return `<div id="n-${n.id}" class="node tile" style="${style}">
          <svg class="ring" viewBox="0 0 192 192"><rect id="n-${n.id}-ring" x="2" y="2" width="188" height="188" rx="50" pathLength="100"/></svg>
          ${logo(n.vendor, 84)}
        </div>`;
  }
  if (n.kind === "doc") {
    const lines = DOC_LINES.map((w) => `<i class="ln" style="width:${w}px"></i>`).join("");
    return `<div id="n-${n.id}" class="node doc${n.lines ? " " + n.lines : ""}" style="${style}">
          ${lines}${n.badge ? `<span class="badge">${CHECK}</span>` : ""}
        </div>`;
  }
  const ticks = [0, 90, 180, 270]
    .map((a) => `<line x1="75" y1="12" x2="75" y2="22" transform="rotate(${a} 75 75)"/>`)
    .join("");
  return `<div id="n-${n.id}" class="node clock" style="${style}">
          <svg viewBox="0 0 150 150" width="150" height="150">
            <circle cx="75" cy="75" r="73" fill="#1A1A1A" stroke="#2E2E2E" stroke-width="2"/>
            <g stroke="#4A4A4A" stroke-width="4" stroke-linecap="round">${ticks}</g>
            <line x1="75" y1="75" x2="75" y2="44" stroke="#EDEDED" stroke-width="7" stroke-linecap="round" transform="rotate(300 75 75)"/>
            <g id="clock-m"><line x1="75" y1="75" x2="75" y2="26" stroke="#EDEDED" stroke-width="5" stroke-linecap="round"/></g>
            <circle cx="75" cy="75" r="7" fill="#EDEDED"/>
          </svg>
        </div>`;
}

const DATA = {
  base: Object.fromEntries(NODES.map((n) => [n.id, n.base])),
  pos: P,
  comet: COMET,
  win: WIN,
  shot: SHOT,
  crop: CROP,
  item: ITEM_H,
  composer: COMPOSER,
  col: COL,
  threadComposerY: THREAD_COMPOSER_Y,
  card: CARD,
  promptLen: PROMPT.length,
  answerLines: ANSWER.lines.length,
};

// --------------------------------------------------------------- timeline
const TIMELINE = String.raw`
const D = ${JSON.stringify(DATA)};
const tl = gsap.timeline({ paused: true });
const el = (id) => document.getElementById(id);

// Camera: centers capture point (cx, cy) in the window at scale s, clamped so
// the view never leaves the capture.
function view(cx, cy, s) {
  const k = s * D.shot;
  const hw = D.win.w / 2 / k;
  const hh = D.win.h / 2 / k;
  cx = Math.min(Math.max(cx, hw), 2560 - hw);
  cy = Math.min(Math.max(cy, D.crop + hh), 1680 - hh);
  return { x: D.win.w / 2 - cx * k, y: D.win.h / 2 - (cy - D.crop) * k, scale: s };
}
function cam(t, dur, cx, cy, s, ease) {
  tl.to("#app", { ...view(cx, cy, s), duration: dur, ease }, t);
}
const show = (sel, t) => tl.set(sel, { opacity: 1 }, t);
const hide = (sel, t) => tl.set(sel, { opacity: 0 }, t);
function point(t, dur, x, y, ease = "power2.inOut") {
  tl.to("#cursor", { x, y, duration: dur, ease }, t);
}
function click(t, x, y) {
  tl.to("#cursor", { scale: 0.86, duration: 0.07, ease: "power2.out" }, t);
  tl.to("#cursor", { scale: 1, duration: 0.14, ease: "power2.out" }, t + 0.07);
  tl.set("#ripple", { x, y }, t);
  tl.fromTo("#ripple", { scale: 0.3, opacity: 0.55 }, { scale: 1.5, opacity: 0, duration: 0.4, ease: "power2.out", immediateRender: false }, t);
}
function ticker(sel, from, to, t, dur) {
  const node = el(sel.slice(1));
  const o = { v: from };
  tl.fromTo(o, { v: from }, { v: to, duration: dur, ease: "none", immediateRender: false,
    onUpdate: () => { node.textContent = Math.round(o.v) + "s"; } }, t);
}

// ------------------------------------------------------- 1. every agent
tl.fromTo("#cursor", { x: 1760, y: 1180, opacity: 0, scale: 1 }, { opacity: 1, duration: 0.2, ease: "power1.out" }, 0.15);
cam(0.1, 0.75, 1450, 1080, 1.5, "power2.inOut");
point(0.2, 0.62, 1000, 815);
tl.fromTo("#trig-bg", { opacity: 0 }, { opacity: 1, duration: 0.12, ease: "power1.out" }, 0.74);
click(0.86, 1000, 815);
tl.fromTo("#dropdown", { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.2, ease: "power2.out" }, 0.9);
point(1.0, 0.32, 1180, 1225, "power2.out");
[[1.12, 1], [1.2, 2], [1.28, 3]].forEach(([t, i]) => tl.set("#dd-hl", { y: i * D.item }, t));
// Wheel through the providers: Codex, then Claude Code, then Antigravity.
tl.fromTo("#dd-scroll", { y: 0 }, { y: -336, duration: 0.6, ease: "power1.inOut" }, 1.36);
[[1.5, 4], [1.63, 5], [1.76, 6]].forEach(([t, i]) => tl.set("#dd-hl", { y: i * D.item }, t));
point(1.98, 0.18, 1180, 1302, "power2.out");
tl.set("#dd-hl", { y: 7 * D.item }, 2.06);
point(2.2, 0.16, 1180, 1406, "power2.out");
tl.set("#dd-hl", { y: 8 * D.item }, 2.28);
tl.to("#dropdown", { opacity: 0, scale: 0.97, duration: 0.14, ease: "power2.in" }, 2.42);
tl.to("#trig-bg", { opacity: 0, duration: 0.14 }, 2.42);

// ------------------------------------------------- 2. slash command
cam(2.42, 0.45, 1450, 500, 1.5, "power2.inOut");
point(2.45, 0.38, 1060, 740);
click(2.84, 1060, 740);
hide("#ph", 2.96);
show("#ty-slash", 2.96);
tl.fromTo("#ty-slash .ch", { opacity: 0 }, { opacity: 1, duration: 0.01, stagger: 0.16 }, 2.96);
show("#slash-all-w", 3.0);
tl.fromTo("#slash-all", { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.1, ease: "power2.out" }, 3.0);
hide("#slash-all-w", 3.12);
show("#slash-b-w", 3.12);
hide("#slash-b-w", 3.28);
show("#slash-be-w", 3.28);
// Enter inserts the command chip; the arguments follow.
hide("#slash-be-w", 3.52);
hide("#ty-slash", 3.52);
show("#ty-cmd", 3.52);
tl.fromTo("#cmd-chip", { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.16, ease: "power2.out" }, 3.52);
tl.fromTo("#ty-cmd .ch", { opacity: 0 }, { opacity: 1, duration: 0.01, stagger: 0.019 }, 3.66);
show("#send-on", 3.66);
const TYPED = 3.66 + D.promptLen * 0.019;
point(TYPED - 0.1, 0.32, 2240, 812);
click(TYPED + 0.26, 2240, 812);

// --------------------------------------------- 3. the thread starts
const TS = TYPED + 0.34;
cam(TS, 0.6, 1440, 660, 1.2, "power2.inOut");
tl.to("#cursor", { opacity: 0, duration: 0.2 }, TS);
tl.fromTo("#main-cover", { opacity: 0 }, { opacity: 1, duration: 0.22, ease: "power1.out" }, TS);
tl.to("#composer", { x: D.col.x - D.composer.x, y: D.threadComposerY - D.composer.y, duration: 0.5, ease: "power3.inOut" }, TS);
hide("#ty-cmd", TS + 0.05);
show("#ph", TS + 0.05);
hide("#send-on", TS + 0.05);
show("#send-stop", TS + 0.05);
tl.fromTo("#bubble", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, TS + 0.12);
tl.fromTo("#side-row", { opacity: 0 }, { opacity: 1, duration: 0.25 }, TS + 0.15);
tl.fromTo("#working", { opacity: 0 }, { opacity: 1, duration: 0.2 }, TS + 0.3);
tl.to("#wk-run", { opacity: 0.45, duration: 0.3, ease: "sine.inOut", yoyo: true, repeat: 3 }, TS + 0.5);
tl.fromTo("#card", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, TS + 0.38);
const TR = TS + 0.5;
ticker("#wf-total", 0, 9, TR, 0.75);
["par", "r1", "r2", "r3"].forEach((r, i) =>
  tl.fromTo("#bar-" + r, { scaleX: 0 }, { scaleX: 0.28, duration: 0.75, ease: "none" }, TR + i * 0.03),
);

// Zoom through the parallel bars into imagined workflows.
const TZ = TR + 0.45;
cam(TZ, 0.55, 1300, 540, 2.6, "power2.in");
tl.to("#app", { opacity: 0, duration: 0.3, ease: "power1.in" }, TZ + 0.25);
tl.fromTo("#canvas", { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: 0.35, ease: "power2.out" }, TZ + 0.3);
const TA = TZ + 0.32;

// --------------------------------------- 4. imagined workflows (flashes)
const A = gsap.timeline();
const MAIN = ["codex", "claude", "ag"];
const off = (id, p) => ({ x: p[0] - D.base[id][0], y: p[1] - D.base[id][1] });
function moveTo(ids, scene, t, dur) {
  ids.forEach((id) => A.to("#n-" + id, { ...off(id, D.pos[scene][id]), duration: dur, ease: "power3.inOut" }, t));
}
function draw(ids, t, stagger) {
  ids.forEach((e, i) => A.to("#" + e + "-b", { strokeDashoffset: 0, duration: 0.28, ease: "power2.inOut" }, t + i * stagger));
}
function retract(ids, t) {
  A.to(ids.map((e) => "#" + e + "-b"), { opacity: 0, duration: 0.2, ease: "power1.in" }, t);
}
function flow(e, t, d) {
  const c = el(e + "-c");
  const len = +c.dataset.len;
  A.fromTo(c, { strokeDashoffset: D.comet + 6 }, { strokeDashoffset: -(len + 6), duration: d, ease: "power1.inOut", immediateRender: false }, t);
  A.set("#" + e + "-t", { opacity: 0.95 }, t);
  A.fromTo("#" + e + "-t", { strokeDashoffset: len }, { strokeDashoffset: 0, duration: d, ease: "power1.inOut", immediateRender: false }, t);
  A.to("#" + e + "-t", { opacity: 0, duration: 0.4, ease: "power1.out" }, t + d + 0.04);
  return t + d;
}
function run(id, t, d) {
  const ring = "#n-" + id + "-ring";
  A.set(ring, { opacity: 1 }, t);
  A.fromTo(ring, { strokeDashoffset: 100 }, { strokeDashoffset: 0, duration: d, ease: "none", immediateRender: false }, t);
  A.to(ring, { opacity: 0, duration: 0.22, ease: "power1.out" }, t + d);
  pulse(id, t + d);
  return t + d;
}
function pulse(id, t) {
  A.to("#n-" + id, { scale: 1.07, duration: 0.1, ease: "power2.out" }, t);
  A.to("#n-" + id, { scale: 1, duration: 0.26, ease: "power2.inOut" }, t + 0.1);
}
let badgeShown = false;
function fill(id, t, badge) {
  A.to("#n-" + id + " .ln", { backgroundColor: "#DADADA", duration: 0.16, stagger: 0.04, ease: "power1.out" }, t);
  if (id !== "f") pulse(id, t);
  if (badge) {
    A.fromTo("#n-" + id + " .badge", { scale: 0 }, { scale: 1, duration: 0.28, ease: "back.out(2.4)", immediateRender: id === "f" || !badgeShown }, t + 0.08);
    if (id === "out") badgeShown = true;
  }
}
function clear(id, t, badge) {
  A.to("#n-" + id + " .ln", { backgroundColor: "#2F2F2F", duration: 0.18, ease: "power1.in" }, t);
  if (badge) A.to("#n-" + id + " .badge", { scale: 0, duration: 0.16, ease: "power2.in" }, t);
}
function chain(steps, t) {
  for (const [k, id, d] of steps) t = k === "f" ? flow(id, t, d) : run(id, t, d);
  return t;
}

// Parallel: the three researchers, imagined as three vendors.
MAIN.forEach((id, i) =>
  A.fromTo("#n-" + id, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.6)" }, i * 0.06),
);
A.fromTo("#n-in", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.35, ease: "power3.out" }, 0.05);
A.fromTo("#n-out", { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.35, ease: "power3.out" }, 0.1);
const S4E = MAIN.flatMap((m) => ["e4i-" + m, "e4o-" + m]);
draw(S4E, 0.12, 0.03);
const ends4 = MAIN.map((m, i) => flow("e4o-" + m, run(m, flow("e4i-" + m, 0.4, 0.18), [0.2, 0.28, 0.24][i]), 0.18));
fill("out", Math.max(...ends4), true);

// Chain: work handed across vendors.
const T3 = Math.max(...ends4) + 0.38;
retract(S4E, T3);
clear("out", T3, true);
moveTo([...MAIN, "in", "out"], "s3", T3 + 0.04, 0.45);
const S3E = ["e3a", "e3b", "e3c", "e3d"];
draw(S3E, T3 + 0.36, 0.05);
let t = chain([["f", "e3a", 0.13], ["r", "codex", 0.14], ["f", "e3b", 0.13], ["r", "claude", 0.14], ["f", "e3c", 0.13], ["r", "ag", 0.14], ["f", "e3d", 0.13]], T3 + 0.56);
fill("out", t, true);

// Loop: agents iterate until the result holds.
const T5 = t + 0.38;
retract(S3E, T5);
clear("out", T5, true);
moveTo([...MAIN, "in", "out"], "s5", T5 + 0.04, 0.45);
const S5E = ["e5a", "e5b", "e5c", "e5d", "e5e"];
draw(S5E, T5 + 0.36, 0.04);
t = chain([
  ["f", "e5a", 0.14], ["r", "ag", 0.07], ["f", "e5b", 0.13], ["r", "codex", 0.07], ["f", "e5c", 0.13], ["r", "claude", 0.07],
  ["f", "e5d", 0.12], ["r", "ag", 0.05], ["f", "e5b", 0.1], ["r", "codex", 0.05], ["f", "e5c", 0.1], ["r", "claude", 0.05],
  ["f", "e5e", 0.14],
], T5 + 0.56);
fill("out", t, true);

// Pull back: the loop is one stage of a larger graph across vendors.
const T6 = t + 0.08;
A.to("#world", { scale: 0.58, duration: 0.95, ease: "power2.inOut" }, T6);
A.to("#world", { scale: 0.565, duration: 1.6, ease: "none" }, T6 + 0.95);
clear("in", T6 + 0.3, false);
clear("out", T6 + 0.3, true);
const EXTRA = ["clock", "b1", "b2", "b3", "u1", "l1", "u2", "l2", "d1", "d2", "f"];
EXTRA.forEach((id, i) =>
  A.fromTo("#n-" + id, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(1.5)" }, T6 + 0.2 + i * 0.03),
);
const S6E = [
  "e6c-b1", "e6c-b2", "e6c-b3", "e6b1-in", "e6b2-in", "e6b3-in", "e6b1-u1", "e6b3-l1",
  "e6u1-u2", "e6l1-l2", "e6u2-d1", "e6l2-d2", "e6out-d1", "e6out-d2", "e6d1-f", "e6d2-f",
];
draw(S6E, T6 + 0.38, 0.02);
const T0 = T6 + 0.7;
A.fromTo("#clock-m", { rotation: 0, svgOrigin: "75 75" }, { rotation: 360, svgOrigin: "75 75", duration: 1.9, ease: "none", immediateRender: false }, T0 - 0.2);
pulse("clock", T0 - 0.05);
const bDone = ["b1", "b2", "b3"].map((b, i) => run(b, flow("e6c-" + b, T0, 0.2), [0.18, 0.22, 0.2][i]));
const inAt = Math.max(...["b1", "b2", "b3"].map((b, i) => flow("e6" + b + "-in", bDone[i], 0.18)));
const tU = chain([["f", "e6b1-u1", 0.22], ["r", "u1", 0.18], ["f", "e6u1-u2", 0.24], ["r", "u2", 0.16], ["f", "e6u2-d1", 0.2]], bDone[0]);
const tL = chain([["f", "e6b3-l1", 0.22], ["r", "l1", 0.2], ["f", "e6l1-l2", 0.24], ["r", "l2", 0.16], ["f", "e6l2-d2", 0.2]], bDone[2]);
fill("in", inAt, false);
const tOut = chain([
  ["f", "e5a", 0.12], ["r", "ag", 0.06], ["f", "e5b", 0.1], ["r", "codex", 0.06], ["f", "e5c", 0.1], ["r", "claude", 0.06], ["f", "e5e", 0.12],
], inAt + 0.03);
fill("out", tOut, false);
const dIn = [flow("e6out-d1", tOut, 0.18), flow("e6out-d2", tOut, 0.18)];
const d1 = run("d1", Math.max(tU, dIn[0]), 0.18);
const d2 = run("d2", Math.max(tL, dIn[1]), 0.18);
const tF = Math.max(flow("e6d1-f", d1, 0.18), flow("e6d2-f", d2, 0.18));
fill("f", tF, true);
A.to("#n-f", { scale: 1.3, duration: 0.4, ease: "back.out(2)" }, tF);
const A_END = tF + 0.45;
// The flashes play at speed so the imagined part stays under five seconds.
const SPEED = A_END / 4.4;
A.timeScale(SPEED);
tl.add(A, TA);
const TB = TA + A_END / SPEED;

// ------------------------------------ 5. back in the thread: it finishes
// Research has finished while we were away.
["r1", "r2", "r3"].forEach((r) => tl.set("#bar-" + r, { scaleX: 1, backgroundColor: "#5E5E5E" }, TB - 0.3));
tl.set("#bar-par", { scaleX: 1, backgroundColor: "#8F89A6" }, TB - 0.3);
hide("#ph1-run", TB - 0.3);
show("#ph1-done", TB - 0.3);
show(["#ph1-dur", "#rd-par", "#rd-r1", "#rd-r2", "#rd-r3"], TB - 0.3);
tl.set("#app", view(1460, 560, 1.7), TB - 0.3);
tl.to("#canvas", { scale: 1.2, opacity: 0, duration: 0.4, ease: "power2.in" }, TB - 0.25);
tl.to("#app", { opacity: 1, duration: 0.35, ease: "power1.out" }, TB - 0.1);
cam(TB - 0.1, 0.6, 1460, 600, 1.35, "power3.out");
ticker("#wf-total", 34, 41, TB, 0.85);
// Synthesis: the summarizer runs and completes.
tl.to("#card-r", { attr: { height: D.card.h1 - 2 }, duration: 0.35, ease: "power2.out" }, TB + 0.1);
tl.fromTo(["#ph2", "#row-sum"], { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out", stagger: 0.06 }, TB + 0.15);
tl.fromTo("#bar-sum", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "none" }, TB + 0.25);
tl.to("#bar-sum", { backgroundColor: "#5E5E5E", duration: 0.12 }, TB + 0.85);
hide("#ph2-run", TB + 0.85);
show(["#ph2-done", "#ph2-dur", "#rd-sum"], TB + 0.85);
hide("#wk-run", TB + 0.9);
show("#wk-done", TB + 0.9);
hide("#send-stop", TB + 0.9);

// The answer streams in below the card.
cam(TB + 0.75, 0.6, 1460, 860, 1.35, "power2.inOut");
tl.fromTo("#ans-h", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, TB + 1.0);
for (let i = 0; i < D.answerLines; i++)
  tl.fromTo("#ans-" + i, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.42, ease: "none" }, TB + 1.15 + i * 0.42);
const TDONE = TB + 1.15 + D.answerLines * 0.42;
tl.fromTo("#ans-act", { opacity: 0 }, { opacity: 1, duration: 0.25 }, TDONE);

// ------------------------------------ 6. home again for a clean loop
const THOME = TDONE + 0.7;
cam(THOME, 0.45, 1280, 721.6, 1, "power2.inOut");
tl.fromTo("#home-end", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power1.inOut" }, THOME + 0.35);
window.__demoEnd = THOME + 0.75;

window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
tl.seek(0);
`;

// Evaluate the timeline once with a stub to find where the loop ends.
function measureEnd() {
  const stub = () => {
    const t = {};
    for (const k of ["to", "fromTo", "set", "seek", "add", "timeScale"]) t[k] = () => t;
    return t;
  };
  const sandbox = {
    gsap: { timeline: stub },
    document: {
      getElementById: (id) => ({ dataset: { len: EDGES.find((e) => id === e.id + "-c")?.len ?? 0 } }),
    },
    window: {},
  };
  vm.runInNewContext(TIMELINE, sandbox);
  return sandbox.window.__demoEnd;
}
const DURATION = Math.ceil((measureEnd() + 0.05) * 10) / 10;

// -------------------------------------------------------------------- css
const px = (n) => `${n}px`;
const CSS = `
@font-face { font-family: "Inter"; src: url("assets/fonts/Inter-Regular.ttf") format("truetype"); font-weight: 400; }
@font-face { font-family: "Inter"; src: url("assets/fonts/Inter-Medium.ttf") format("truetype"); font-weight: 500; }
@font-face { font-family: "Inter"; src: url("assets/fonts/Inter-SemiBold.ttf") format("truetype"); font-weight: 600; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0E0E0E; }
#root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #0E0E0E;
  font-family: "Inter", sans-serif; -webkit-font-smoothing: antialiased; }
#stage { position: absolute; inset: 0; }
.winbox { position: absolute; left: ${px(WIN.x)}; top: ${px(WIN.y)}; width: ${px(WIN.w)}; height: ${px(WIN.h)};
  border-radius: 28px; overflow: hidden; }
#win { background: #111111; }
#app { position: absolute; left: 0; top: 0; width: ${px(WIN.w)}; height: ${px(WIN.h)}; transform-origin: 0 0; }
.cap { position: absolute; left: 0; top: 0; width: 2560px; height: 1680px; transform-origin: 0 0;
  transform: scale(${SHOT}) translateY(-${CROP}px); }
.cap > img { position: absolute; left: 0; top: 0; width: 2560px; height: 1680px; display: block; }
.patch { position: absolute; background: #121212; }
.brand { position: absolute; left: 196px; top: 48px; width: 204px; height: 46px; padding-left: 8px; background: #151515;
  display: flex; align-items: center; gap: 16px; font-size: 28px; line-height: 34px; font-weight: 500; color: #EEEEEE; }
.brand > i { width: 40px; height: 40px; flex: none; background: url(assets/endo-mark.png) 0 0 / 40px 40px no-repeat; }
.ico { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ico svg, .ico-i svg { width: 100%; height: 100%; display: block; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

/* composer */
#composer { position: absolute; border-radius: 60px; background: #212121; }
.in-line { position: absolute; left: 28px; top: 28px; height: 52px; font-size: 32px; line-height: 52px; white-space: pre; }
#ph { position: absolute; left: 0; top: 0; color: #8C8C8C; }
#ty-slash, #ty-cmd { position: absolute; left: 0; top: 0; color: #F2F2F2; opacity: 0; white-space: pre; display: flex; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 10px; height: 46px; padding: 0 16px 0 12px; margin-right: 12px;
  border-radius: 12px; background: #353535; color: #F0F0F0; font-size: 30px; font-weight: 500; }
.chip .ico { width: 30px; height: 30px; color: #CFCFCF; }
.chip.light { background: #D6D6D6; color: #1A1A1A; }
.chip.light .ico { color: #3A3A3A; }
.foot { position: absolute; left: 0; top: 106px; width: 100%; height: 60px; color: #F2F2F2; }
.foot > * { position: absolute; top: 0; height: 60px; display: flex; align-items: center; }
.f-plus { left: 30px; width: 34px; color: #A8A8A8; }
#trig-bg { left: ${px(TRIGGER.x - COMPOSER.x)}; width: ${px(TRIGGER.w)}; border-radius: 14px; background: #2C2C2C; opacity: 0; }
.f-model { left: ${px(110)}; gap: 0; font-size: 28px; }
.f-model .logo { margin: 0 14px 0 0; }
.f-model b { font-weight: 500; }
.f-model i { font-style: normal; color: #8C8C8C; margin-left: 17px; }
.f-chev { width: 30px; height: 30px; color: #8C8C8C; margin-left: 16px; }
.f-ws { left: ${px(489)}; font-size: 28px; gap: 0; }
.f-ws > .ico:first-child { width: 30px; height: 30px; color: #D0D0D0; margin-right: 15px; }
.f-ws b { font-weight: 600; }
.send { left: ${px(1447)}; width: 72px; height: 72px !important; top: -6px !important; border-radius: 50%;
  background: #666666; color: #161616; justify-content: center; }
.send.on { background: #F4F4F4; color: #111111; opacity: 0; }

/* model dropdown */
#dropdown { position: absolute; width: 576px; border-radius: 24px; background: #171717; border: 2px solid rgba(255,255,255,0.1);
  box-shadow: 0 24px 60px rgba(0,0,0,0.5); overflow: hidden; transform-origin: 0 0; opacity: 0; }
.dd-list { position: relative; height: 600px; overflow: hidden; }
#dd-scroll { position: absolute; left: 0; top: 0; width: 100%; height: ${8 * 2 + MODELS.length * ITEM_H}px; }
#dd-hl { position: absolute; left: 8px; top: 8px; width: 556px; height: ${ITEM_H}px; border-radius: 16px; background: #262626; }
.mi { position: absolute; left: 8px; width: 556px; height: ${ITEM_H}px; padding: 16px 72px 16px 24px; display: flex; gap: 16px; color: #F2F2F2; }
.mi-logo { width: 28px; height: 28px; margin-top: 6px; flex: none; }
.mi-logo svg { width: 28px; height: 28px; display: block; }
.mi-text { display: flex; flex-direction: column; }
.mi-text b { font-size: 28px; line-height: 40px; font-weight: 500; white-space: nowrap; }
.mi-text small { font-size: 24px; line-height: 32px; color: #A1A1A1; white-space: nowrap; }
.mi-check { position: absolute; right: 24px; top: 20px; width: 32px; height: 32px; color: #F2F2F2; }
.dd-effort { display: flex; align-items: center; justify-content: space-between; gap: 24px; height: 84px; padding: 0 24px;
  border-top: 2px solid rgba(255,255,255,0.1); }
.dd-effort small { font-size: 24px; color: #A1A1A1; }
.dd-effort span { display: flex; gap: 4px; }
.dd-effort i { font-style: normal; font-size: 24px; color: #A1A1A1; padding: 8px 16px; border-radius: 12px; }
.dd-effort i.on { background: #262626; color: #F2F2F2; font-weight: 500; }

/* slash menu */
.slash-w { position: absolute; left: ${px(COMPOSER.x)}; width: ${px(COMPOSER.w)}; bottom: ${px(1680 - COMPOSER.y + 16)};
  transform-origin: 0 100%; opacity: 0; }
.slash { transform-origin: 0 100%; display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 32px; background: #171717;
  border: 2px solid rgba(255,255,255,0.06); box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
.si { display: flex; align-items: center; gap: 20px; padding: 16px 20px; border-radius: 20px; color: #F2F2F2; font-size: 27px; }
.si.on { background: rgba(250,250,250,0.06); }
.si-ico { width: 28px; height: 28px; color: rgba(250,250,250,0.35); }
.si-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.si-top { display: flex; align-items: center; gap: 20px; white-space: nowrap; overflow: hidden; }
.si-top b { font-weight: 500; flex: none; }
.si-top small { font-size: 24px; color: rgba(250,250,250,0.45); overflow: hidden; text-overflow: ellipsis; }
.si-hint { font-size: 24px; color: #A1A1A1; white-space: nowrap; }
.si kbd { font-family: ui-monospace, Menlo, monospace; font-size: 20px; color: rgba(250,250,250,0.45);
  background: rgba(250,250,250,0.06); border-radius: 6px; padding: 2px 8px; }

/* thread */
#main-cover { position: absolute; left: 486px; top: 4px; width: 2064px; height: 1672px; background: #111111; opacity: 0; }
#side-row { position: absolute; left: 34px; top: 472px; width: 428px; height: 88px; padding: 12px 0 0 0; background: #131313; opacity: 0; }
#side-row span { display: block; height: 64px; line-height: 64px; padding: 0 16px; border-radius: 14px; background: #262626;
  color: #EDEDED; font-size: 30px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bubble { position: absolute; right: ${px(2560 - COL.x - COL.w)}; top: 80px; display: flex; align-items: center; padding: 22px 32px 22px 22px;
  border-radius: 40px; background: #EDEDED; color: #1A1A1A; font-size: 31px; white-space: nowrap; opacity: 0; }
#working { position: absolute; left: ${px(COL.x)}; top: 214px; height: 48px; display: flex; align-items: center; gap: 12px;
  font-size: 31px; color: #8C8C8C; opacity: 0; }
#working > span { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 12px; line-height: 48px; white-space: nowrap; }
#wk-done { opacity: 0; }
.wk-chev { width: 28px; height: 28px; }
#card { position: absolute; height: ${px(CARD.h1)}; opacity: 0; color: #EDEDED; }
.card-bg { position: absolute; left: 0; top: 0; overflow: visible; }
.card-bg rect { fill: #171717; stroke: rgba(255,255,255,0.07); stroke-width: 2; }
.card-h { position: absolute; left: 34px; right: 32px; top: 30px; display: flex; justify-content: space-between; align-items: baseline; }
.card-h b { font-size: 27px; font-weight: 500; }
.card-h .mono { font-size: 22px; color: #858585; }
.ph { position: absolute; left: 34px; right: 32px; height: 80px; }
.ph-chev { position: absolute; left: 0; top: 8px; width: 28px; height: 28px; color: #8C8C8C; }
.ph b { position: absolute; left: 42px; top: 0; font-size: 24px; line-height: 44px; font-weight: 500; }
.ph-st { position: absolute; left: 42px; top: 40px; font-size: 22px; color: #8C8C8C; white-space: nowrap; }
.ph-st span { position: absolute; left: 0; top: 0; }
.ph-dur { position: absolute; right: 0; top: 10px; font-size: 22px; color: #B0B0B0; opacity: 0; }
[id$="-done"] { opacity: 0; }
.row { position: absolute; left: 0; width: 100%; height: 32px; }
.row-l { position: absolute; top: 0; font-size: 24px; line-height: 32px; color: #B3B3B3; white-space: nowrap; }
.bar { position: absolute; top: 9px; height: 14px; border-radius: 7px; transform-origin: 0 50%; }
.bar.agent { background: #5B7FD0; }
.bar.par { background: #9C95B8; }
.row-d { position: absolute; right: 32px; top: 0; font-size: 22px; line-height: 32px; color: #858585; opacity: 0; }
#answer { position: absolute; height: 900px; color: #E6E6E6; }
#ans-h { position: absolute; left: 0; top: 580px; font-size: 42px; font-weight: 600; line-height: 56px; color: #F2F2F2; opacity: 0; }
.ans-l { position: absolute; left: 0; display: block; font-size: 31px; line-height: 48px; white-space: nowrap; clip-path: inset(0 100% 0 0); }
#ans-act { position: absolute; left: 0; top: 820px; display: flex; gap: 30px; color: #8C8C8C; opacity: 0; }
#ans-act .ico { width: 34px; height: 34px; }
#cursor { position: absolute; left: 0; top: 0; width: 56px; height: 56px; opacity: 0; transform-origin: 8px 6px; }
#cursor svg { display: block; }
#ripple { position: absolute; left: -40px; top: -40px; width: 80px; height: 80px; border-radius: 50%;
  border: 4px solid rgba(244,242,238,0.8); opacity: 0; }

/* imagined workflows */
#canvas { background: #111111; opacity: 0; transform-origin: 936px 516px; }
#grid { position: absolute; inset: 0; background-image: radial-gradient(circle, #262626 1.6px, transparent 2.2px);
  background-size: 44px 44px; background-position: 0 2px; }
#world { position: absolute; left: -${px(WIN.x)}; top: -${px(WIN.y)}; width: 1920px; height: 1080px; transform-origin: 960px 560px; }
#edges { position: absolute; left: 0; top: 0; overflow: visible; }
.eb { fill: none; stroke: #383838; stroke-width: 4; }
.et { fill: none; stroke: #5B7FD0; stroke-width: 4; opacity: 0; }
.ec { fill: none; stroke: #F4F2EE; stroke-width: 9; stroke-linecap: round; }
.node { position: absolute; }
.tile { width: 168px; height: 168px; border-radius: 40px; background: #1B1B1B; border: 2px solid #2E2E2E;
  display: flex; align-items: center; justify-content: center; }
.tile .logo { display: block; }
.ring { position: absolute; left: -12px; top: -12px; width: 192px; height: 192px; overflow: visible; }
.ring rect { fill: none; stroke: #5B7FD0; stroke-width: 5; stroke-linecap: round; stroke-dasharray: 100 100; stroke-dashoffset: 100; }
.doc { width: 120px; height: 150px; border-radius: 18px; background: #1B1B1B; border: 2px solid #2E2E2E; padding: 30px 0 0 20px; }
.doc .ln { display: block; height: 9px; border-radius: 5px; background: #2F2F2F; margin-bottom: 15px; }
.doc.prompt .ln { background: #5A5A5A; }
.badge { position: absolute; right: -16px; top: -16px; width: 46px; height: 46px; border-radius: 50%;
  background: #F4F2EE; border: 5px solid #111111; display: flex; align-items: center; justify-content: center; }
.badge svg { width: 26px; height: 26px; display: block; }
.clock { width: 150px; height: 150px; }
.clock svg { display: block; }
#home-end { opacity: 0; background: #111111; }
#frame { position: absolute; left: ${px(WIN.x)}; top: ${px(WIN.y)}; width: ${px(WIN.w)}; height: ${px(WIN.h)};
  border-radius: 28px; border: 2px solid #2B2B2B; }
`;

// Covers the capture's recording badge, and redraws the sidebar title as the
// shipped Endo header (mark and name); the capture predates the rename.
const BADGE_PATCH = `<i class="patch" style="left:0;top:0;width:156px;height:57px"></i><span class="brand"><i></i>Endo</span>`;
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>${CSS}</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${DURATION}" data-width="1920" data-height="1080">
      <div id="stage" class="clip" data-start="0" data-duration="${DURATION}" data-track-index="0">
        <div id="win" class="winbox">
          <div id="app">
            <div id="app-inner" class="cap">
              <img src="assets/home.jpg" alt="" />
              ${BADGE_PATCH}
              ${threadHtml()}
              ${composerHtml()}
              <div id="ripple"></div>
              <div id="cursor">${CURSOR}</div>
            </div>
          </div>
        </div>
        <div id="canvas" class="winbox">
          <div id="grid"></div>
          <div id="world">
            <svg id="edges" width="1920" height="1080" viewBox="0 0 1920 1080">
        ${edgeSvg}
            </svg>
        ${NODES.map(nodeHtml).join("\n        ")}
          </div>
        </div>
        <div id="home-end" class="winbox">
          <div class="cap" style="background:url(assets/home.jpg) 0 0 / 2560px 1680px no-repeat">${BADGE_PATCH}</div>
        </div>
        <div id="frame"></div>
      </div>
    </div>
    <script>${TIMELINE}</script>
  </body>
</html>
`;

writeFileSync(join(ROOT, "index.html"), html);
console.log(`index.html: ${DURATION}s`);
