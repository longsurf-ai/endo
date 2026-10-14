// Purpose: Defines failures exposed by the Permission service contract.

import { Schema } from "effect";

import { ID, Ruleset } from "./types";

/**
 * The user rejected approval without corrective feedback; ask treats this
 * as a defect that aborts the operation.
 * @example
 * const error = new DeclinedError({});
 */
export class DeclinedError extends Schema.TaggedError<DeclinedError>()(
  "Permission.DeclinedError",
  {},
) {
  /**
   * Describes rejection to callers that consume the standard Error interface.
   * @example
   * const message = new DeclinedError({}).message;
   */
  override get message() {
    return "Permission for this operation was declined.";
  }
}

/**
 * The user rejected approval and supplied feedback for the Agent.
 * @example
 * const error = new CorrectedError({feedback: 'Use the public report instead.'});
 */
export class CorrectedError extends Schema.TaggedError<CorrectedError>()(
  "Permission.CorrectedError",
  { feedback: Schema.String },
) {
  /**
   * Carries the user's exact feedback through ordinary tool-error projection.
   * @example
   * const message = new CorrectedError({feedback: 'Read the public file.'}).message;
   */
  override get message() {
    return `The user declined this operation: ${this.feedback}`;
  }
}

/**
 * Configured rules prohibit the requested operation before user approval.
 * @example
 * const error = new BlockedError({
 *   rules: [{action: 'edit', resource: '*', decision: 'deny'}],
 * });
 */
export class BlockedError extends Schema.TaggedError<BlockedError>()(
  "Permission.BlockedError",
  { rules: Ruleset },
) {
  /**
   * Explains the policy block and relevant rules without serializing the error.
   * @example
   * const message = new BlockedError({rules: []}).message;
   */
  override get message() {
    const rules = this.rules
      .map((rule) => `${rule.decision} ${rule.action} ${rule.resource}`)
      .join("; ");
    return `Permission policy blocks this operation.${rules ? ` Rules: ${rules}` : ""}`;
  }
}

/**
 * A reply targets an unknown request or one that has already settled.
 * @example
 * const error = new NotFoundError({requestID: ID.make('per_missing')});
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "Permission.NotFoundError",
  { requestID: ID },
) {}
