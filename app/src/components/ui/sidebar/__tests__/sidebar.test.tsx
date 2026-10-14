// Purpose: Keep sidebar resizing bounded and release captured gestures cleanly.
import { fireEvent, render, screen } from "@testing-library/react";

import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@openchart/app/components/ui/sidebar";

function SidebarState() {
  const { width, state, isResizing } = useSidebar();
  return <output>{`${width} ${state} ${isResizing}`}</output>;
}

test("dragging resizes, clamps, and collapses without leaving a live gesture", () => {
  render(
    <SidebarProvider>
      <Sidebar variant="floating">
        <SidebarRail />
      </Sidebar>
      <SidebarState />
    </SidebarProvider>,
  );
  const rail = screen.getByRole("button", { name: "Toggle Sidebar" });
  Object.assign(rail, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 240,
  } as DOMRect);
  const pointer = (type: string, clientX: number) => {
    fireEvent(
      rail,
      Object.assign(
        new MouseEvent(type, { bubbles: true, button: 0, clientX }),
        {
          pointerId: 1,
        },
      ),
    );
  };

  pointer("pointerdown", 240);
  pointer("pointermove", 290);
  expect(screen.getByRole("status")).toHaveTextContent("290px expanded true");
  pointer("pointermove", 600);
  expect(screen.getByRole("status")).toHaveTextContent("320px expanded true");
  pointer("pointermove", 100);
  expect(screen.getByRole("status")).toHaveTextContent("224px collapsed true");
  pointer("pointercancel", 100);
  pointer("pointermove", 400);
  expect(screen.getByRole("status")).toHaveTextContent("224px collapsed false");
  fireEvent.click(rail);
  expect(screen.getByRole("status")).toHaveTextContent("224px expanded false");
});

test("Cmd+B only toggles the sidebar owning keyboard focus", () => {
  render(
    <SidebarProvider>
      <SidebarState />
      <SidebarProvider embedded>
        <button>File focus</button>
        <SidebarState />
      </SidebarProvider>
    </SidebarProvider>,
  );
  const states = screen.getAllByRole("status");
  fireEvent.keyDown(screen.getByRole("button", { name: "File focus" }), {
    key: "b",
    metaKey: true,
  });
  expect(states[0]).toHaveTextContent("expanded");
  expect(states[1]).toHaveTextContent("collapsed");
});
