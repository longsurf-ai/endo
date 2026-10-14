// Purpose: Select image attachments from canonical AG-UI tool activities.
import type { Message } from "@ag-ui/core";
import { z } from "zod";

const Attachment = z.object({
  id: z.string(),
  mime: z.string(),
  url: z.string(),
  filename: z.string().optional(),
});
export type ToolAttachment = z.infer<typeof Attachment>;
const Attachments = z.object({ attachments: z.array(Attachment).optional() });
const ComputerUse = z.object({
  // Activity details are arbitrary JSON; only objects can carry our extension.
  details: z.preprocess(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined,
    z
      .object({
        computerUse: z
          .object({
            title: z.string(),
            screenshot: Attachment.omit({ id: true }).optional(),
          })
          .optional(),
      })
      .optional(),
  ),
});

/** Activity fields are extension JSON; validate their shape at this boundary. */
export function toolAttachments(activity: unknown): ToolAttachment[] {
  if (activity === undefined) return [];
  const attachments = Attachments.parse(activity).attachments ?? [];
  const screenshot =
    ComputerUse.parse(activity).details?.computerUse?.screenshot;
  return screenshot
    ? [...attachments, { ...screenshot, id: "display-screenshot" }]
    : attachments;
}

export function isImageAttachment(attachment: ToolAttachment): boolean {
  return (
    /^image\/(png|jpeg|webp|gif)$/.test(attachment.mime) &&
    /^(data:image\/|https?:\/\/)/.test(attachment.url)
  );
}

/**
 * Selects this view's latest user turn, matching the Working/Worked boundary.
 * All captures retain transcript order, including multiple images from one tool.
 * Child runs have their own view; their messages never split or join this turn.
 * No frame buffer is kept, so live updates and restored history use the same path.
 * @example const sequence = computerUseSequence(snapshot.messages);
 */
export function computerUseSequence(messages: readonly Message[]) {
  let turnId: string | undefined;
  const frames: ComputerFrame[] = [];
  for (const message of messages) {
    if (message.subagentRunId !== undefined) continue;
    if (message.role === "user") {
      turnId = message.id;
      frames.length = 0;
      continue;
    }
    if (
      message.role !== "activity" ||
      message.activityType !== "openchart.tool"
    )
      continue;
    const computer = ComputerUse.parse(message.content).details?.computerUse;
    if (!computer) continue;
    for (const image of toolAttachments(message.content).filter(
      isImageAttachment,
    )) {
      frames.push({
        ...image,
        id: `${message.id}:${image.id}`,
        title: computer.title,
      });
    }
  }
  const [first, ...rest] = frames;
  if (!first) return undefined;
  return {
    id: turnId ?? first.id,
    frames: [first, ...rest] as [ComputerFrame, ...ComputerFrame[]],
  };
}

export type ComputerFrame = ToolAttachment & { title: string };
export type ComputerSequence = NonNullable<
  ReturnType<typeof computerUseSequence>
>;
