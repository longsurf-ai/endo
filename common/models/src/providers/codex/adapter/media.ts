// Purpose: Normalizes native MCP tool media and computer-use screenshots into the shared result envelope.
import type { ProviderNativeToolOutput } from "@openchart/models/provider-protocol";
import type { McpToolCallResult } from "./protocol";

type Attachment = ProviderNativeToolOutput["attachments"][number];
const IMAGE_MIMES: ReadonlySet<string> = new Set<Attachment["mime"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function imageAttachment(entry: unknown): Attachment | undefined {
  const image = entry as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (
    image?.type !== "image" ||
    typeof image.data !== "string" ||
    typeof image.mimeType !== "string" ||
    !IMAGE_MIMES.has(image.mimeType)
  )
    return undefined;
  const mime = image.mimeType as Attachment["mime"];
  return { mime, url: `data:${mime};base64,${image.data}` };
}

function surfaceScreenshot(meta: unknown): {
  computerUse: boolean;
  screenshot?: Attachment;
} {
  const surface = (meta as Record<string, unknown> | null | undefined)?.[
    "codex/toolSurface"
  ] as { kind?: unknown; screenshot?: { url?: unknown } | null } | undefined;
  const computerUse =
    surface?.kind === "computerUse" || surface?.kind === "browserUse";
  const url = surface?.screenshot?.url;
  const mime =
    typeof url === "string"
      ? url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,/)?.[1]
      : undefined;
  return {
    computerUse,
    ...(computerUse && mime && typeof url === "string"
      ? { screenshot: { mime: mime as Attachment["mime"], url } }
      : {}),
  };
}

/**
 * Returns the media envelope for an MCP result carrying images or a computer-use
 * screenshot, or undefined for plain results. Attachments are model-facing; the
 * surface screenshot is display-only and omitted when already attached.
 * @example const media = mcpToolMedia(item.result);
 */
export function mcpToolMedia(
  result: McpToolCallResult,
): ProviderNativeToolOutput | undefined {
  const attachments: Attachment[] = [];
  const remaining: unknown[] = [];
  for (const entry of result.content) {
    const image = imageAttachment(entry);
    if (image) attachments.push(image);
    else remaining.push(entry);
  }
  const surface = surfaceScreenshot(result._meta);
  const screenshot =
    surface.screenshot &&
    !attachments.some((file) => file.url === surface.screenshot?.url)
      ? surface.screenshot
      : undefined;
  if (attachments.length === 0 && !screenshot) return undefined;
  const texts = remaining.map(
    (entry) => (entry as { type?: unknown; text?: unknown }) ?? {},
  );
  const output =
    result.structuredContent == null &&
    texts.every(
      (entry) => entry.type === "text" && typeof entry.text === "string",
    )
      ? texts.map((entry) => entry.text as string).join("\n")
      : {
          content: remaining,
          structuredContent: result.structuredContent ?? null,
        };
  return {
    output: output as ProviderNativeToolOutput["output"],
    attachments,
    ...(surface.computerUse
      ? {
          computerUse: {
            title: "Computer use",
            ...(screenshot ? { screenshot } : {}),
          },
        }
      : {}),
  };
}
