// Purpose: Owns the parent-session anchor contract for user-selected dig-ins.

import { Schema, Struct } from "effect";

// @agent invariant: Each anchor links a nonempty source range to one child
// session; the child Session ID identifies the persisted link.
/** A dig-in link stored on the parent session; offsets address the source Part. */
export const SessionAnchor = Schema.Struct({
  partId: Schema.String.check(Schema.isMinLength(1)),
  // The rendered selection is a snapshot, not a slice of Markdown source.
  text: Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      message: "Selected text must not be blank",
    }),
  ),
  startOffset: Schema.Finite.check(Schema.isInt()).check(
    Schema.isGreaterThanOrEqualTo(0),
  ),
  endOffset: Schema.Finite.check(Schema.isInt()).check(
    Schema.isGreaterThanOrEqualTo(0),
  ),
  childSessionId: Schema.String.check(Schema.isMinLength(1)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .check(
    Schema.makeFilter(
      (value) =>
        value.endOffset > value.startOffset || {
          path: ["endOffset"],
          issue: "A dig-in must select a nonempty source range",
        },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** Parsed dig-in anchor, including its stable child Session ID. */
export type SessionAnchor = typeof SessionAnchor.Type;
