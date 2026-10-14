// Purpose: Shares the lossless composer Part constraint across saved targets and editing.

import { Result, Schema } from "effect";
import { readLeadingDirective } from "./directive-formatter";

/**
 * @agent invariant: Saved Parts must round-trip through the composer losslessly.
 * Frontend restoration and backend saved targets share this constraint.
 *
 * Parts = Quote? (Text | Command)? Image*
 *         ? = zero or one; * = zero or more
 *
 * Quote   Plain quote context, without source or identity fields.
 * Text    Nonempty verbatim text; no leading /command or command chip.
 * Command One workflow or manual compaction (auto: false).
 * Image   image/* MIME, with required filename and url strings.
 *
 * Valid:   [Text], [Quote, Command, Image], [Image, Image]
 * Invalid: [Text, Command], [Text, Text], [Image, Text], [Quote, Quote]
 *
 * Reject unsupported Parts/fields; never drop, merge, or reorder content.
 * Empty drafts are valid here; saved targets/admission require a nonempty input.
 * Execution-only context and command registry validation remain server-owned.
 */
const ComposerPart = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(
      Schema.isMinLength(1),
      Schema.makeFilter((text) => readLeadingCommand(text) === undefined, {
        message: "Leading commands must be stored as command Parts, not text.",
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("context"),
    context: Schema.Struct({
      kind: Schema.Literal("quote"),
      text: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    mime: Schema.String.check(Schema.isStartsWith("image/")),
    filename: Schema.String,
    url: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("compaction"),
    auto: Schema.Literal(false),
  }),
  Schema.Struct({
    type: Schema.Literal("workflow"),
    workflow: Schema.String,
    args: Schema.JsonObject,
  }),
]);

function hasComposerOrder(parts: readonly (typeof ComposerPart.Type)[]) {
  let index = parts[0]?.type === "context" ? 1 : 0;
  const body = parts[index];
  if (
    body?.type === "text" ||
    body?.type === "workflow" ||
    body?.type === "compaction"
  )
    index++;
  return parts.slice(index).every((part) => part.type === "file");
}

const ComposerParts = Schema.Array(ComposerPart)
  .pipe(Schema.mutable)
  .check(
    Schema.makeFilter(hasComposerOrder, {
      message:
        "Saved prompts require an optional quote, then text or one command, then images. Text and commands cannot be combined; put workflow instructions in its arguments.",
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/**
 * Restores the typed composer subset without discarding fields or changing values.
 * Empty drafts are allowed. Command identity/arguments remain registry-owned.
 * Throws a SchemaError for unsupported Part shapes, fields, or order.
 * @example const parts = parseComposerParts(savedPrompt.parts);
 */
export const parseComposerParts = Schema.decodeUnknownSync(ComposerParts);

/**
 * Applies the same composer constraint as a saved prompt schema refinement.
 * Returns a field diagnostic for rejection; nonempty input remains caller-owned.
 * @example AgentPromptInput.check(Schema.makeFilter(checkPromptConstraint));
 */
export function checkPromptConstraint(input: {
  readonly parts: readonly unknown[];
}): Schema.FilterIssue | undefined {
  const result = Schema.decodeUnknownResult(ComposerParts)(input.parts);
  if (Result.isFailure(result))
    return { path: ["parts"], issue: result.failure.issue };
}

/**
 * Reads a leading command chip or /command, preserving arguments after one delimiter.
 * @example const command = readLeadingCommand('/best-of-n 3 Research Google');
 */
export function readLeadingCommand(text: string) {
  const leading = readLeadingDirective(text);
  if (leading?.item.type === "command")
    return {
      command: leading.item.id,
      arguments: leading.rest.replace(/^\s/, ""),
    };
  const match = /^\/([^\s/]+)(?:\s([\s\S]*))?$/.exec(text);
  return match ? { command: match[1]!, arguments: match[2] ?? "" } : undefined;
}
