// Purpose: Render Office documents and delimited text with OOXML's read-only viewers.
import { useEffect, useRef } from "react";
import { DocxScrollViewer } from "@silurus/ooxml/docx";
import { PptxScrollViewer } from "@silurus/ooxml/pptx";
import { XlsxSheetViewer, XlsxViewer } from "@silurus/ooxml/xlsx";

export type OfficeFormat = "docx" | "xlsx" | "pptx" | "csv" | "tsv";

/**
 * Mount one read-only viewer for `bytes`; new bytes or a new format replace it and
 * unmounting destroys it. Parse and render failures reach `onError` once per load.
 * @example <OfficeViewer bytes={bytes} format="xlsx" onError={setFailure} />
 */
export default function OfficeViewer({
  bytes,
  format,
  onError,
}: {
  bytes: Uint8Array;
  format: OfficeFormat;
  onError: (error: Error) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(onError);
  latest.current = onError;

  useEffect(() => {
    let active = true;
    const report = (cause: unknown) => {
      if (active)
        latest.current(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
    };
    const delimited = format === "csv" || format === "tsv";
    // The viewer owns this node's children; React only owns the outer root.
    const host = document.createElement(delimited ? "canvas" : "div");
    host.className = "block size-full";
    root.current!.append(host);
    const options = { onError: report };
    // The viewer keeps its source; give it a copy so the cached read stays intact.
    const source = bytes.slice().buffer;
    let viewer: { destroy(): void };
    let loaded: Promise<void>;
    if (delimited) {
      const sheet = new XlsxSheetViewer(host as HTMLCanvasElement, {
        ...options,
        resizable: true,
      });
      loaded = sheet.load(source, { format });
      viewer = sheet;
    } else if (format === "xlsx") {
      const workbook = new XlsxViewer(host, { ...options, resizable: true });
      loaded = workbook.load(source);
      viewer = workbook;
    } else {
      const pages =
        format === "docx"
          ? new DocxScrollViewer(host, options)
          : new PptxScrollViewer(host, options);
      loaded = pages.load(source);
      viewer = pages;
    }
    loaded.catch(report);
    return () => {
      active = false;
      viewer.destroy();
      host.remove();
    };
  }, [bytes, format]);

  return <div ref={root} className="size-full overflow-hidden" />;
}
