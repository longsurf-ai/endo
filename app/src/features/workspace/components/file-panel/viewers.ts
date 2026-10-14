// Purpose: Choose the one viewer for a Workspace read; a new file type is one line here.

/** Every panel a Workspace file can open in. Text viewers edit drafts; the rest are read-only. */
export type FileViewer =
  | "markdown"
  | "delimited"
  | "code"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "docx"
  | "xlsx"
  | "pptx"
  | "none";

/**
 * Pick a viewer from the server's MIME (which decides text versus bytes) and the
 * filename (which picks among text editors and Office formats). Unknown bytes get
 * `none`, the default-app fallback. @example fileViewer("prices.csv", "text/plain"); // "delimited"
 */
export function fileViewer(path: string, mediaType: string): FileViewer {
  if (mediaType === "text/plain") {
    if (/\.(md|markdown)$/i.test(path)) return "markdown";
    if (/\.(csv|tsv)$/i.test(path)) return "delimited";
    return "code";
  }
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (/\.docx$/i.test(path)) return "docx";
  if (/\.xlsx$/i.test(path)) return "xlsx";
  if (/\.pptx$/i.test(path)) return "pptx";
  return "none";
}
