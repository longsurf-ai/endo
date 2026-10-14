// Purpose: Locks dig-in selection identity and rejects incomplete or obsolete anchors.

import { Schema, Result } from "effect";

import { expect, test } from "vitest";
import { SessionAnchor } from "./session-anchor";

const anchor = {
  partId: "prt_source",
  text: " Selected text ",
  startOffset: 4,
  endOffset: 25,
  childSessionId: "ses_child",
} satisfies SessionAnchor;

test("preserves rendered text independently of its source range", () => {
  expect(Schema.decodeUnknownSync(SessionAnchor)(anchor)).toEqual(anchor);
});

test.each([
  { context: "surrounding text" },
  { kind: "dig_in" },
  { kind: "claim" },
  { partId: "" },
  { text: " \n " },
  { startOffset: -1 },
  { startOffset: 1.5 },
  { endOffset: 4 },
  { endOffset: 3 },
  { endOffset: 4.5 },
  { startOffset: undefined },
  { endOffset: undefined },
  { childSessionId: "" },
  { sessionIntentId: "retired" },
])("rejects invalid anchor fields %j", (fields) => {
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(SessionAnchor)({ ...anchor, ...fields }),
    ),
  ).toBe(false);
});
