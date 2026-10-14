// Purpose: Owns failures of pending question replies.
import { Schema } from "effect";
import { ID } from "./types";

/** The native request has ended or another view already answered it. */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "Question.NotFoundError",
  { requestID: ID },
) {}

/** The answer does not match the pending questions; the request stays open. */
export class InvalidReply extends Schema.TaggedError<InvalidReply>()(
  "Question.InvalidReply",
  { message: Schema.String },
) {}
