// Purpose: Defines pending questions and user replies independently of execution.
import { Schema } from "effect";
import type {
  ProviderQuestion,
  ProviderQuestionReply,
} from "@openchart/models/provider-question";

/** Identifies one pending native question invocation. */
export const ID = Schema.String.check(Schema.isStartsWith("que_")).pipe(
  Schema.brand("Question.ID"),
);
export type ID = typeof ID.Type;

/** Provider-neutral display data, already decoded by the native adapter. */
export const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.String }),
  ),
  multiple: Schema.Boolean,
  allowFreeform: Schema.Boolean,
  secret: Schema.Boolean,
}) satisfies Schema.Schema<ProviderQuestion>;

/** Complete pending view; requests belong to the prompt's existing Session. */
export const Request = Schema.Struct({
  id: ID,
  sessionID: Schema.String,
  questions: Schema.Array(Question),
});
export type Request = typeof Request.Type;

/** Submitted answers are checked against the pending questions by the owner. */
export const Reply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("answered"),
    answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("skipped") }),
]) satisfies Schema.Schema<ProviderQuestionReply>;
export type Reply = typeof Reply.Type;

/** Reply to one invocation, without creating another prompt or Run. */
export const ReplyInput = Schema.Struct({ requestID: ID, reply: Reply });
export type ReplyInput = typeof ReplyInput.Type;
