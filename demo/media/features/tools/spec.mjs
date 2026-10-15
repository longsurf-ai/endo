// Edit lists for the README feature GIFs. Each feature cuts real Endo
// recordings (CDP screencasts in the capture directory) into one clip.
//
// segments: [recording, from, to, speed] in source seconds; output time is
//   the sum of (to - from) / speed.
// camera: views in logical app pixels (1280×840). `at` is "REC@seconds" (the
//   output moment that source time lands on) or a number (output seconds);
//   the camera eases to {cx, cy, s} over `d` seconds. s = 1 shows the whole app.
// relaunch: output-time cuts dressed as quitting and reopening the app.

/** @type {Record<string, {segments: [string, number, number, number][], camera: {at: string | number, cx: number, cy: number, s: number, d?: number}[], relaunch?: string[], cursorStart?: Record<string, [number, number]>}>} */
export const FEATURES = {
  // Codex, then Claude, then Gemini answer in one thread; Settings shows each
  // provider's plan usage.
  agents: {
    cursorStart: { A: [900, 300], A2: [700, 600] },
    segments: [
      ["A", 0.35, 0.85, 1],
      ["A", 0.85, 3.3, 3],
      ["A", 3.3, 3.55, 1],
      ["A", 3.55, 12.4, 14],
      ["A", 12.4, 13.3, 1],
      ["A", 14.8, 16.45, 1.6],
      ["A", 16.85, 19.1, 3],
      ["A", 19.1, 21.3, 6],
      ["A", 21.3, 23.8, 2],
      ["A", 25.5, 27.1, 1.6],
      ["A", 27.5, 29.6, 3],
      ["A", 29.6, 38.9, 16],
      ["A", 38.9, 40.2, 1.2],
      ["A2", 0.3, 1.6, 1.5],
      ["A2", 2.6, 5.0, 1.25],
    ],
    camera: [
      { at: 0, cx: 760, cy: 360, s: 1.55, d: 0 },
      { at: "A@3.5", cx: 755, cy: 330, s: 1.35, d: 0.5 },
      { at: "A@14.8", cx: 700, cy: 560, s: 1.35, d: 0.45 },
      { at: "A@19.0", cx: 755, cy: 520, s: 1.3, d: 0.5 },
      { at: "A@25.5", cx: 700, cy: 590, s: 1.35, d: 0.45 },
      { at: "A@29.5", cx: 755, cy: 600, s: 1.3, d: 0.5 },
      { at: "A2@0.3", cx: 640, cy: 420, s: 1, d: 0.35 },
      { at: "A2@1.5", cx: 860, cy: 330, s: 1.45, d: 0.6 },
    ],
  },
  // A workspace file composes Codex, Claude and Gemini; running it from chat
  // renders the real Workflow card.
  workflow: {
    cursorStart: { B: [900, 600] },
    segments: [
      ["B", 0.3, 1.95, 1.2],
      ["B", 1.95, 5.5, 1.3],
      ["B", 5.5, 6.65, 1.4],
      ["B", 6.65, 10.2, 2.6],
      ["B", 10.2, 17.5, 9],
      ["B", 17.5, 44.5, 9],
      ["B", 44.5, 46.6, 1.4],
    ],
    camera: [
      { at: 0, cx: 640, cy: 420, s: 1, d: 0 },
      { at: "B@1.95", cx: 760, cy: 230, s: 1.55, d: 0.7 },
      { at: "B@3.6", cx: 760, cy: 330, s: 1.55, d: 0.8 },
      { at: "B@5.5", cx: 760, cy: 380, s: 1.45, d: 0.45 },
      { at: "B@10.2", cx: 755, cy: 470, s: 1.3, d: 0.6 },
    ],
  },
  // Select text, Dig In beside the thread, then reopen the app: the thread,
  // its Dig In and the answers persist, and another agent continues.
  "dig-in": {
    cursorStart: { C: [1000, 760], C2: [900, 500] },
    relaunch: ["C2@0.5"],
    segments: [
      ["C", 0.25, 1.1, 1],
      ["C", 1.1, 2.1, 1],
      ["C", 2.1, 3.5, 1.5],
      ["C", 3.5, 5.5, 3],
      ["C", 5.5, 19.0, 16],
      ["C", 19.0, 21.7, 2.2],
      ["C2", 0.5, 1.1, 1],
      ["C2", 1.1, 3.7, 1.6],
      ["C2", 3.7, 5.5, 1.6],
      ["C2", 5.5, 6.8, 1.8],
      ["C2", 7.3, 9.35, 3],
      ["C2", 9.35, 13.6, 10],
      ["C2", 13.6, 16.3, 2.2],
    ],
    camera: [
      { at: 0, cx: 755, cy: 330, s: 1.4, d: 0 },
      { at: "C@2.1", cx: 724, cy: 380, s: 1.15, d: 0.5 },
      { at: "C@5.5", cx: 724, cy: 420, s: 1.15, d: 0.5 },
      { at: "C2@0.5", cx: 520, cy: 300, s: 1.25, d: 0 },
      { at: "C2@1.2", cx: 755, cy: 400, s: 1.3, d: 0.5 },
      { at: "C2@3.7", cx: 724, cy: 400, s: 1.15, d: 0.5 },
      { at: "C2@5.4", cx: 1000, cy: 560, s: 1.45, d: 0.45 },
      { at: "C2@9.3", cx: 724, cy: 480, s: 1.15, d: 0.5 },
    ],
  },
};
