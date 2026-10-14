// Purpose: Exercise floating-viewer docking through real Motion gestures and viewport changes.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FloatingViewer } from "@openchart/app/components/ui/floating-viewer/floating-viewer";

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
      pointerType = "mouse";
      isPrimary = true;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 320, 300),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function frame() {
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

async function dragTo(x: number, y: number) {
  const viewer = screen.getByRole("region", { name: "Reference preview" });
  fireEvent.pointerDown(viewer, {
    button: 0,
    buttons: 1,
    clientX: 800,
    clientY: 550,
  });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 790, clientY: 540 });
  await frame();
  fireEvent.pointerMove(window, { buttons: 1, clientX: x, clientY: y });
  await frame();
  fireEvent.pointerUp(window, { button: 0, clientX: x, clientY: y });
}

test("releasing even in the middle docks into the pointer's corner quadrant", async () => {
  render(
    <FloatingViewer
      ariaLabel="Reference preview"
      bounds={{ left: 240, top: 60, right: 1280, bottom: 650 }}
    >
      <div>Reference</div>
    </FloatingViewer>,
  );
  for (const [x, y, corner] of [
    [740, 365, "bottom-left"],
    [740, 345, "top-left"],
    [780, 345, "top-right"],
    [780, 365, "bottom-right"],
  ] as const) {
    await dragTo(x, y);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: `Move viewer from ${corner}` }),
      ).toBeVisible(),
    );
    const viewer = screen.getByRole("region", { name: "Reference preview" });
    const dockX = corner.endsWith("right") ? 944 : 256;
    const dockY = corner.startsWith("bottom") ? 334 : 76;
    await waitFor(() =>
      expect(viewer).toHaveStyle({
        transform: `translate3d(${dockX}px, ${dockY}px, 0px)`,
      }),
    );
  }
});

test("keyboard corner cycling retains content and docks again after resizing", async () => {
  const { rerender, unmount } = render(
    <FloatingViewer ariaLabel="Reference preview">
      <input aria-label="Draft" defaultValue="Keep me" />
    </FloatingViewer>,
  );
  const input = screen.getByRole("textbox", { name: "Draft" });
  const move = screen.getByRole("button", {
    name: "Move viewer from bottom-right",
  });
  move.focus();
  await userEvent.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Move viewer from bottom-left" }),
  ).toHaveFocus();
  rerender(
    <FloatingViewer ariaLabel="Reference preview">
      <input aria-label="Draft" defaultValue="Changed default" />
    </FloatingViewer>,
  );
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
  expect(input).toHaveValue("Keep me");
  vi.stubGlobal("innerWidth", 600);
  vi.stubGlobal("innerHeight", 500);
  fireEvent(window, new Event("resize"));
  const viewer = screen.getByRole("region", { name: "Reference preview" });
  await waitFor(() => expect(viewer.style.transform).toContain("184px"));
  const observer = vi.mocked(ResizeObserver).mock.results[0]!.value;
  unmount();
  expect(observer.disconnect).toHaveBeenCalledOnce();
});
