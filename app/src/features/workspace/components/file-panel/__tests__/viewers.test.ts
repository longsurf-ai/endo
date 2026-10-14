import { expect, test } from "vitest";
import { fileViewer } from "@openchart/app/features/workspace/components/file-panel/viewers";

test.each([
  ["notes.MD", "text/plain", "markdown"],
  ["prices.csv", "text/plain", "delimited"],
  ["fills.TSV", "text/plain", "delimited"],
  ["main.tea", "text/plain", "code"],
  ["Makefile", "text/plain", "code"],
  ["report.pdf", "application/pdf", "pdf"],
  ["chart.png", "image/png", "image"],
  ["clip.mp3", "audio/mpeg", "audio"],
  ["clip.mp4", "video/mp4", "video"],
  ["memo.docx", "application/octet-stream", "docx"],
  ["positions.XLSX", "application/octet-stream", "xlsx"],
  ["deck.pptx", "application/octet-stream", "pptx"],
  ["archive.zip", "application/octet-stream", "none"],
  // Invalid UTF-8 never reaches a text editor, whatever its name.
  ["broken.csv", "application/octet-stream", "none"],
])("%s (%s) opens in %s", (path, mediaType, viewer) => {
  expect(fileViewer(path, mediaType)).toBe(viewer);
});
