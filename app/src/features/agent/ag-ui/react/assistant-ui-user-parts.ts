// Purpose: Restores structured user Parts that the text-only native projection keeps in metadata.

import type { Message } from "@ag-ui/core";
import type {
  CompleteAttachment,
  DataMessagePart,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";
import { z } from "zod";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Native AG-UI metadata is open-ended. Parse only the Part fields this view owns.
const WorkflowPart = z.object({
  type: z.literal("workflow"),
  workflow: z.string(),
  args: z.record(z.string(), z.json()),
});

/** Parsed workflow identity and arguments for the user message renderer. */
export type UserWorkflowPart = z.infer<typeof WorkflowPart>;

const FilePart = z.object({
  type: z.literal("file"),
  mime: z.string(),
  url: z.string(),
  filename: z.string().optional(),
});

const UserPart = z.union([
  WorkflowPart,
  FilePart,
  z.object({
    type: z.literal("context"),
    context: z.union([
      z.object({ kind: z.literal("quote"), text: z.string() }),
      z.object({ kind: z.literal("dig_in"), quoteText: z.string() }),
      z.object({
        kind: z
          .string()
          .refine((kind) => kind !== "quote" && kind !== "dig_in"),
      }),
    ]),
  }),
  z.object({
    type: z
      .string()
      .refine(
        (type) => type !== "context" && type !== "workflow" && type !== "file",
      ),
  }),
]);

// The shape the upstream converter builds from native media content.
function attachment(
  part: z.infer<typeof FilePart>,
  id: number,
): CompleteAttachment {
  const filename =
    part.filename === undefined ? {} : { filename: part.filename };
  if (part.mime.startsWith("image/"))
    return {
      id: String(id),
      type: "image",
      name: part.filename ?? "image",
      contentType: part.mime,
      status: { type: "complete" },
      content: [{ type: "image", image: part.url, ...filename }],
    };
  return {
    id: String(id),
    type:
      part.mime.startsWith("audio/") || part.mime.startsWith("video/")
        ? "file"
        : "document",
    name: part.filename ?? "file",
    contentType: part.mime,
    status: { type: "complete" },
    content: [
      { type: "file", data: part.url, mimeType: part.mime, ...filename },
    ],
  };
}

function userParts(message: Message) {
  const dataParts: DataMessagePart[] = [];
  const attachments: CompleteAttachment[] = [];
  if (
    message.role !== "user" ||
    !record(message.metadata) ||
    message.metadata.parts === undefined
  )
    return { dataParts, attachments };
  for (const part of z.array(UserPart).parse(message.metadata.parts)) {
    if ("workflow" in part) {
      dataParts.push({ type: "data", name: "workflow", data: part });
    } else if ("url" in part) {
      attachments.push(attachment(part, attachments.length));
    } else if ("context" in part) {
      if ("text" in part.context)
        dataParts.push({
          type: "data",
          name: "quote",
          data: part.context.text,
        });
      else if ("quoteText" in part.context)
        dataParts.push({
          type: "data",
          name: "dig_in",
          data: part.context.quoteText,
        });
    }
  }
  return { dataParts, attachments };
}

function addUserParts(
  message: ThreadMessageLike,
  dataParts: readonly DataMessagePart[],
  attachments: readonly CompleteAttachment[],
): ThreadMessageLike {
  if (message.role !== "user") return message;
  const content =
    typeof message.content === "string"
      ? message.content
        ? [{ type: "text" as const, text: message.content }]
        : []
      : message.content;
  return {
    ...message,
    ...(dataParts.length === 0 ? {} : { content: [...dataParts, ...content] }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

/**
 * Convert native messages, restoring workflow and quote Parts before the prompt
 * text and attachments from file Parts, all read from native Part metadata.
 * Never mutates input; malformed view data throws.
 * @example const converted = convertMessagesWithUserParts(messages);
 */
export function convertMessagesWithUserParts(
  messages: readonly Message[],
): ThreadMessageLike[] {
  const parts = new Map(
    messages.map((message) => [message.id, userParts(message)] as const),
  );
  return fromAgUiMessages(messages).map((message) => {
    const user = parts.get(message.id ?? "");
    return user === undefined
      ? message
      : addUserParts(message, user.dataParts, user.attachments);
  });
}
