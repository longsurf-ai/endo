// Purpose: Toasts stay above an open dialog, mounted outside the isolated app root.
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { expect, it } from "vitest";
import { Toaster } from "@openchart/app/components/ui/sonner/sonner";

it("mounts toasts in a body portal, beside dialogs and outside the app root", async () => {
  const root = document.body.appendChild(document.createElement("div"));
  root.id = "root";
  root.className = "isolate";
  const view = render(<Toaster />, { container: root });
  act(() => {
    toast.error("Couldn’t load study preview");
  });
  // Like a dialog's portal, the toast lives outside the isolated root.
  expect(root).not.toContainElement(
    await screen.findByText("Couldn’t load study preview"),
  );
  view.unmount();
  root.remove();
});
