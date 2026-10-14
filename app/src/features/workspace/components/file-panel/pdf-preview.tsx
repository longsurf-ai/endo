// Purpose: Use EmbedPDF's complete viewer with locally bundled PDFium and no nested file tabs.
import { PDFViewer, type PDFViewerRef } from "@embedpdf/react-pdf-viewer";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { useEffect, useRef } from "react";

const colors = {
  background: {
    app: "var(--background)",
    surface: "var(--sidebar)",
    surfaceAlt: "var(--muted)",
    elevated: "var(--popover)",
    input: "var(--background)",
  },
  foreground: {
    primary: "var(--foreground)",
    secondary: "var(--muted-foreground)",
    muted: "var(--muted-foreground)",
  },
  border: { default: "var(--border)", subtle: "var(--border)" },
  interactive: {
    hover: "var(--accent)",
    selected: "var(--accent)",
    focus: "var(--ring)",
  },
};

/** Preview a workspace PDF using the upstream UI and local assets. @example <PdfPreview url={url} dark={false} /> */
export default function PdfPreview({
  url,
  dark,
}: {
  url: string;
  dark: boolean;
}) {
  const viewer = useRef<PDFViewerRef>(null);
  useEffect(() => {
    viewer.current?.container?.setTheme(dark ? "dark" : "light");
  }, [url, dark]);
  return (
    <PDFViewer
      key={url}
      ref={viewer}
      config={{
        src: url,
        // The bundled worker's initialization hangs in Electron/Vite; use the upstream direct engine.
        worker: false,
        wasmUrl,
        tabBar: "never",
        theme: {
          preference: dark ? "dark" : "light",
          light: colors,
          dark: colors,
        },
        fonts: { ui: null, signature: null },
        fontFallback: null,
        disabledCategories: [
          "annotation",
          "redaction",
          "signature",
          "document-open",
        ],
      }}
      style={{ height: "100%", width: "100%" }}
    />
  );
}
