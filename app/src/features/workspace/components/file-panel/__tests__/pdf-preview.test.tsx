// Purpose: Preserve the viewer's reading state on theme changes, replacing it only for new file bytes.
import { fireEvent, render, screen } from "@testing-library/react";
import PdfPreview from "@openchart/app/features/workspace/components/file-panel/pdf-preview";

const setTheme = vi.hoisted(() => vi.fn());
vi.mock("@embedpdf/react-pdf-viewer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    PDFViewer: forwardRef(function Viewer(_props, ref) {
      useImperativeHandle(ref, () => ({ container: { setTheme } }), []);
      return <input aria-label="PDF page" defaultValue="1" />;
    }),
  };
});

test("theme changes preserve the reading position while a new URL replaces the document", () => {
  const view = render(<PdfPreview url="blob:original" dark={false} />);
  const page = screen.getByRole("textbox", { name: "PDF page" });
  fireEvent.change(page, { target: { value: "12" } });
  expect(setTheme).toHaveBeenLastCalledWith("light");

  view.rerender(<PdfPreview url="blob:original" dark />);
  expect(screen.getByRole("textbox", { name: "PDF page" })).toBe(page);
  expect(page).toHaveValue("12");
  expect(setTheme).toHaveBeenLastCalledWith("dark");

  view.rerender(<PdfPreview url="blob:updated" dark />);
  expect(screen.getByRole("textbox", { name: "PDF page" })).not.toBe(page);
  expect(screen.getByRole("textbox", { name: "PDF page" })).toHaveValue("1");
});
