// Purpose: Defines failures of Session history operations.
import { Schema } from "effect";

/** Only an existing, ended Run can advance its owning Session's read position. */
export class ReadRunUnavailable extends Schema.TaggedError<ReadRunUnavailable>()(
  "Session.ReadRunUnavailable",
  {},
) {}

/** Only a settled Assistant reply outside a Dig In can start a branch. */
export class BranchUnavailable extends Schema.TaggedError<BranchUnavailable>()(
  "Session.BranchUnavailable",
  {},
) {}

/** History cannot change while this Session has queued or running work. */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
  "Session.Busy",
  {},
) {}

/** Truncation requires a chat Session and a completed Assistant boundary (or null). */
export class TruncateUnavailable extends Schema.TaggedError<TruncateUnavailable>()(
  "Session.TruncateUnavailable",
  {},
) {}
