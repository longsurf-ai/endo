// Purpose: Convert between assistant-ui drafts and their Agent prompt parts.
import type { CompleteAttachment, ComposerState } from "@assistant-ui/react";

import type { AgentInputs } from "@openchart/app/lib/transport/transport";
import {
  parseComposerParts,
  readLeadingCommand,
} from "@openchart/agent/prompt-constraint";
import { directiveFormatter } from "./directive-formatter";

export { readLeadingCommand } from "@openchart/agent/prompt-constraint";

/** Structured prompt parts derived from the public Agent command contract. */
export type PromptParts = AgentInputs["prompt"]["input"]["parts"];

/** assistant-ui's draft carried through the host's submission and retry state. */
export type ComposerDraft = Pick<ComposerState, "text" | "quote"> & {
  attachments: readonly CompleteAttachment[];
};

/**
 * Restores composer-produced Parts without submitting or modifying input.
 * Recreates editor-only IDs; quote source IDs and original File objects were
 * never serialized. Command spelling is canonicalized by its server owner.
 * Rejects unsupported shapes/order instead of dropping or merging content;
 * command restoration failures propagate to the caller.
 * @example const draft = await fromPromptParts(prompt.parts, remote.restoreCommand);
 */
export async function fromPromptParts(
  parts: PromptParts,
  restoreCommand: (
    part: AgentInputs["restoreCommand"],
  ) => Promise<AgentInputs["buildCommand"]>,
): Promise<ComposerDraft> {
  let text = "";
  let quote: ComposerDraft["quote"];
  const attachments: CompleteAttachment[] = [];
  for (const part of parseComposerParts(parts)) {
    switch (part.type) {
      case "context":
        quote = {
          text: part.context.text,
          // assistant-ui requires an ID, but quote semantics contain only text.
          messageId: crypto.randomUUID(),
        };
        break;
      case "text":
        text = part.text;
        break;
      case "workflow":
      case "compaction": {
        const command = await restoreCommand(part);
        text = directiveFormatter.serialize({
          type: "command",
          id: command.command,
          label: `/${command.command}`,
        });
        if (command.arguments) text += ` ${command.arguments}`;
        break;
      }
      case "file":
        attachments.push({
          id: crypto.randomUUID(),
          type: "image",
          name: part.filename,
          contentType: part.mime,
          status: { type: "complete" },
          content: [{ type: "image", image: part.url }],
        });
        break;
      default:
        throw new Error(`Unsupported composer part: ${part satisfies never}`);
    }
  }
  return { text, quote, attachments };
}

/**
 * Convert a composer draft into ordered Agent prompt parts.
 * Only a leading command chip or /command is expanded; the rest is passed to the
 * backend builder as arguments. Quotes precede the resulting parts; completed
 * image attachments follow as FileParts. Neither
 * construction nor conversion submits a prompt or modifies the draft.
 * @example session.submit(await toPromptParts(draft, remote.buildCommand), model);
 */
export async function toPromptParts(
  { text, quote, attachments }: ComposerDraft,
  buildCommand: (input: AgentInputs["buildCommand"]) => Promise<PromptParts>,
): Promise<PromptParts> {
  const command = readLeadingCommand(text);
  const parts: PromptParts = command
    ? await buildCommand(command)
    : text
      ? [{ type: "text", text }]
      : [];
  return [
    ...(quote
      ? [
          {
            type: "context" as const,
            context: { kind: "quote" as const, text: quote.text },
          },
        ]
      : []),
    ...parts,
    ...attachments.flatMap((attachment) =>
      attachment.content.map((part): PromptParts[number] => {
        if (
          part.type !== "image" ||
          !attachment.contentType?.startsWith("image/")
        )
          throw new Error("Only image attachments are supported.");
        return {
          type: "file",
          mime: attachment.contentType,
          filename: attachment.name,
          url: part.image,
        };
      }),
    ),
  ];
}
