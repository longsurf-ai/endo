// Purpose: Locks Session nullability, binding references, and parent-owned anchors.

import { Schema } from "effect";
import { expect, test } from "vitest";
import { Session, SessionId } from "./session";

const root = {
  id: SessionId.make("ses_parent"),
  parentId: null,
  kind: "chat",
  bindingId: null,
  anchors: null,
  title: "Research",
  compactingAt: null,
  archivedAt: null,
  lastReadRunId: null,
  createdAt: 100,
  updatedAt: 200,
} satisfies Session;

const anchor = {
  partId: "prt_source",
  text: "Selected text",
  startOffset: 4,
  endOffset: 17,
  childSessionId: "ses_child",
};

const parse = Schema.decodeUnknownSync(Session);

test("uses the Session ID owner for generation and persisted identity validation", () => {
  const first = SessionId.create();
  const second = SessionId.create();
  expect(first).toMatch(/^ses_[0-9A-Za-z]{14}$/);
  expect(first > second).toBe(true);
  expect(parse({ ...root, id: first }).id).toBe(first);
  expect(() => parse({ ...root, id: "dsh_other" })).toThrow();
  expect(() => parse({ ...root, id: "unprefixed" })).toThrow();
});

test("preserves explicit absent facts and empty anchors without defaulting", () => {
  expect(parse(root)).toEqual(root);
  expect(parse({ ...root, anchors: [] }).anchors).toEqual([]);
  for (const field of Object.keys(root)) {
    const incomplete: Record<string, unknown> = { ...root };
    delete incomplete[field];
    expect(() => parse(incomplete)).toThrow();
  }
});

test("keeps parent anchors and child ancestry as separate session facts", () => {
  const parent = parse({ ...root, anchors: [anchor] });
  const child = parse({
    ...root,
    id: anchor.childSessionId,
    parentId: parent.id,
    kind: "dig_in",
  });
  expect(parent.anchors).toEqual([anchor]);
  expect(child.parentId).toBe(parent.id);
  expect(child.anchors).toBeNull();
  expect(() =>
    parse({ ...root, anchors: [{ ...anchor, endOffset: anchor.startOffset }] }),
  ).toThrow();
  expect(() =>
    parse({ ...root, anchors: [{ ...anchor, sessionIntentId: "retired" }] }),
  ).toThrow();
});

test("retains binding references and session lifecycle facts", () => {
  const bound = { ...root, bindingId: "binding_1" };
  expect(parse(bound)).toEqual(bound);
  const historical = {
    ...bound,
    compactingAt: 150,
    archivedAt: 400,
  };
  expect(parse(historical)).toEqual(historical);
  expect(Schema.encodeSync(Session)(parse(historical))).toEqual(historical);
});

test.each(["chat", "delegate", "dig_in", "scheduled"])(
  "accepts the existing session purpose %s",
  (kind) => {
    expect(parse({ ...root, kind }).kind).toBe(kind);
  },
);

test.each([
  { kind: null },
  { kind: "" },
  { userId: "user_1" },
  { bindingGeneration: 1 },
  { bindingRotationIntentId: "intent_rotate" },
  { bindingSupersededAt: 300 },
  { kind: "claim" },
  { kind: "unknown" },
  { createdAt: -1 },
  { updatedAt: NaN },
  { archivedAt: Infinity },
  { compactingAt: 1.5 },
  { permission: null },
  { permission: { edit: "ask" } },
  { messages: [] },
  { parts: [] },
  { owner: {} },
  { pendingWake: false },
  { stopping: false },
])("rejects invalid facts or transcript/execution fields %j", (fields) => {
  expect(() => parse({ ...root, ...fields })).toThrow();
});
