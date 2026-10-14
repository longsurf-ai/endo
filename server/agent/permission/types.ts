// Purpose: Owns Permission data schemas independently of service construction.

import { Schema } from "effect";

/** Identifies a permission request independently of its Session or tool call. */
export const ID = Schema.String.check(Schema.isStartsWith("per_")).pipe(
  Schema.brand("Permission.ID"),
);
/** Parsed permission request identity. */
export type ID = typeof ID.Type;

/** The outcome of evaluating permission rules before asking the user. */
export const Decision = Schema.Literals(["allow", "deny", "ask"]);
/** Parsed permission decision. */
export type Decision = typeof Decision.Type;

/** One rule matching an action and resource through wildcard patterns. */
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  decision: Decision,
});
/** Parsed permission rule. */
export type Rule = typeof Rule.Type;

/** Ordered rules; the last matching rule determines the decision. */
export const Ruleset = Schema.Array(Rule);
/** Parsed ordered permission rules. */
export type Ruleset = typeof Ruleset.Type;

/** Links a tool-originated request to its persisted message and tool call. */
export const Source = Schema.Struct({
  /** Identifies a request originating from a tool invocation. */
  type: Schema.Literal("tool"),
  /** Message containing the originating ToolPart, e.g. 'msg_example'. */
  messageID: Schema.String,
  /** Model tool-call ID, e.g. 'call_123'; distinct from Part and permission IDs. */
  callID: Schema.String,
});
/** Parsed permission request origin. */
export type Source = typeof Source.Type;

// Requests expose serializable intent. Deferreds stay private
// to the Permission service and never enter event or lookup payloads.
/**
 * A pending approval request returned to callers and future transports.
 *
 * ```text
 * Permission scope:
 *   agent       -> selects Profile rules; configured deny takes precedence
 *   action      -> caller-defined operation, often a tool name
 *   resources[] -> concrete targets checked for this request
 *   save[]      -> target patterns to remember if the user chooses "always"
 *
 *   "once"   -> approves this request only
 *   "always" -> saves (action, resource pattern) in this application database
 *               Grants are shared across Sessions and Agents, subject to deny.
 *               Neither Session nor Agent is part of the saved grant key.
 *               Sessions carry no permission policy.
 *
 * Example, assuming the selected Profile asks for "read":
 *   ask({agent: 'analyst', sessionID: 'ses_A', action: 'read',
 *        resources: ['/notes/a.md'], save: ['/notes/*']})
 *                         | user replies "always"
 *                         v
 *   saved row: {action: 'read', resource: '/notes/*'}
 *
 *   Later action + target     Matches this saved grant?
 *   read /notes/a.md          yes, including in another Session or Agent
 *   read /notes/sub/b.md      yes, "*" also matches path separators
 *   edit /notes/a.md          no: action differs
 *   read /private/a.md        no: target differs
 *
 * Command example (V2 run_command is not implemented yet):
 *   run_command({command: 'rm -a'})
 *                         | caller constructs the permission request
 *                         v
 *   ask({agent: 'analyst', sessionID: 'ses_A', action: 'run_command',
 *        resources: ['rm -a'], save: ['rm -a']})
 *     |-- configured deny -> blocked, command must not execute
 *     |-- allow           -> caller may execute
 *     `-- ask             -> wait for the user
 *           |-- once   -> allow this invocation
 *           |-- always -> save {action: 'run_command', resource: 'rm -a'}
 *                         and allow this invocation
 *           `-- reject -> command must not execute
 *
 *   Saved resource pattern   Matching target strings for action run_command
 *   rm -a                    rm -a only; not rm -rf or rm -a file
 *   rm *                     rm, rm -a, rm -rf, rm -a file, ...
 *   *                        every target string for this action
 *
 * Permission does not parse commands or infer which files they affect.
 * The caller chooses save[]; "always" does not widen "rm -a" to "rm *".
 * V1 commandPattern uses the first two whitespace-separated words:
 *   command "rm -a file" -> target "rm -a" -> matches saved "rm -a".
 * The table above compares supplied target strings, not full shell commands.
 * ```
 *
 * Both fields match whole strings: "*" = zero or more chars; "?" = one char.
 * Targets can also be commands: "git *" matches "git" and "git status".
 * Targets are caller-supplied strings; the evaluator does not look up Resources.
 *
 * @example
 * Complete input for the illustrative command adapter above:
 * ```ts
 * const input: AskInput = {
 *   id: ID.make('per_example'),
 *   sessionID: 'ses_A',
 *   agent: 'analyst',
 *   action: 'run_command',
 *   resources: ['rm -a'],
 *   save: ['rm -a'],
 *   metadata: {
 *     command: 'rm -a file',
 *     cwd: '/workspace',
 *     description: 'Remove a generated file',
 *   },
 *   source: {type: 'tool', messageID: 'msg_example', callID: 'call_123'},
 * };
 * ```
 */
export const Request = Schema.Struct({
  /** Approval request identity, e.g. 'per_example'; replies target this ID. */
  id: ID,
  /**
   * Existing conversation owning this request, e.g. 'ses_A'. Rejection also
   * settles its other pending requests; saved grants are not Session-scoped.
   */
  sessionID: Schema.String,
  /** Caller-defined operation, e.g. 'run_command'; not inferred from source. */
  action: Schema.String,

  /** Targets checked now, e.g. ['rm -a']; every target must be allowed. */
  resources: Schema.Array(Schema.String),
  /**
   * Caller-chosen target patterns to remember when the user chooses always.
   * For example, ['rm -a'] saves that target; ['rm *'] covers more commands.
   * Empty or omitted means no grant is saved; Permission never derives patterns.
   */
  save: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Optional caller context for display, such as the full command and directory.
   * Example: {command: 'rm -a file', cwd: '/workspace'}.
   * Forwarded through pending requests, events, and list(); ignored by matching
   * and excluded from saved grants.
   */
  metadata: Schema.optional(Schema.JsonObject),

  /** Optional originating tool-call trace; excluded from rule and grant keys. */
  source: Schema.optional(Source),
});
/** Parsed pending permission request. */
export type Request = typeof Request.Type;

/** User decisions for one pending request. */
export const Reply = Schema.Literals(["once", "always", "reject"]);
/** Parsed user decision. */
export type Reply = typeof Reply.Type;

/**
 * Permission request input. The service resolves rules from the selected Agent;
 * null selects no profile policy while retaining approval and saved grants.
 * Callers do not supply an effective ruleset.
 */
export const AskInput = Schema.Struct({
  ...Request.fields,
  /** Optional caller ID; generated when an approval is registered if omitted. */
  id: Schema.optional(ID),
  /**
   * Profile to evaluate, e.g. 'analyst'; omitted uses the default Profile.
   * Provider-native approval requests use null so application profile rules
   * cannot authorize or deny their tools.
   */
  agent: Schema.optional(Schema.NullOr(Schema.String)),
});
/** Parsed input for requesting permission. */
export type AskInput = typeof AskInput.Type;

/** A reply targets one pending request; message carries rejection feedback. */
export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,

  /** Reject with message. */
  message: Schema.optional(Schema.String),
});
/** Parsed reply to a pending request. */
export type ReplyInput = typeof ReplyInput.Type;
