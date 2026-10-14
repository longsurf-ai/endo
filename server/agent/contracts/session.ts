// Purpose: Owns the complete Session data contract independently of execution state.

import { defineId } from "@openchart/identifier";
import { Schema, Struct } from "effect";
import { SessionAnchor } from "./session-anchor";

/** Branded Session identity with a `ses_` prefix and descending creation order. */
export const SessionId = defineId("ses", "Session.ID", "descending");
/** Parsed Session identity; its serialized representation remains a string. */
export type SessionId = typeof SessionId.Type;

/** Session purposes; ordinary conversations use chat. */
export const SessionKind = Schema.Literals([
  "chat",
  "delegate",
  "dig_in",
  "scheduled",
]);
/** Parsed purpose of a specialized session. */
export type SessionKind = typeof SessionKind.Type;

const Timestamp = Schema.Finite.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0),
);

// @agent invariant: Anchors belong to the parent Session. Messages reference
// Sessions; Parts reference Messages. Transcripts and execution fibers stay outside.
/**
 * Complete Session value with explicit nulls for absent persisted facts.
 *
 * Fields retain the V2 session column names and epoch-millisecond timestamps.
 * Permission rules, saved grants, and pending approvals stay outside Session.
 * A null bindingId means unbound. Within a binding, current is the first session
 * ordered by createdAt descending, then id descending for equal timestamps.
 * Sessions have no user identity or ownership dimension in V2.
 */
export const Session = Schema.Struct({
  id: SessionId,
  parentId: Schema.NullOr(Schema.String),
  kind: SessionKind,
  bindingId: Schema.NullOr(Schema.String),
  anchors: Schema.NullOr(Schema.Array(SessionAnchor).pipe(Schema.mutable)),
  title: Schema.String,
  compactingAt: Schema.NullOr(Timestamp),
  archivedAt: Schema.NullOr(Timestamp),
  /** Latest ended Run displayed to the user; null means no result has been read. */
  lastReadRunId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "Session" });

/** Parsed Session facts shared by server consumers and future read boundaries. */
export type Session = typeof Session.Type;
