// Purpose: Defines failures owned by the Agent tool execution boundary.

import { Schema } from "effect";

/** The supplied arguments failed the tool's parameter decoder before execution. */
export class InvalidArgumentsError extends Schema.TaggedError<InvalidArgumentsError>()(
  "Tool.InvalidArgumentsError",
  { tool: Schema.String, detail: Schema.String },
) {
  /**
   * Explains the rejected input so the model can correct its next call.
   * @example
   * const error = new InvalidArgumentsError({tool: 'lookup', detail: 'Missing query'});
   * const feedback = error.message;
   */
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`;
  }
}
