// Purpose: Preserve native select-all while supporting the app's New Alert shortcut.
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useKeyboardShortcut } from "@openchart/app/hooks/use-keyboard-shortcut";

test("Cmd/Ctrl+A runs once outside editing and leaves inputs, Monaco and dialogs alone", () => {
  const create = vi.fn();
  function View() {
    useKeyboardShortcut({
      disabled: false,
      bindings: {
        a: { action: create, allowRepeat: false, allowInEditable: false },
      },
    });
    return (
      <>
        <button>Page action</button>
        <input aria-label="Search" />
        <textarea aria-label="Message" />
        <div role="textbox" aria-label="Composer" contentEditable />
        <textarea aria-label="Code" />
        <section role="dialog" aria-label="Editor">
          <button>Dialog action</button>
        </section>
      </>
    );
  }
  render(<View />);
  const page = screen.getByRole("button", { name: "Page action" });
  expect(fireEvent.keyDown(page, { key: "a", metaKey: true })).toBe(false);
  expect(create).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(page, { key: "a", metaKey: true, repeat: true });
  expect(create).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(page, { key: "a", ctrlKey: true });
  expect(create).toHaveBeenCalledTimes(2);
  for (const name of [
    "Search",
    "Message",
    "Composer",
    "Code",
    "Dialog action",
  ]) {
    const target =
      name === "Dialog action"
        ? screen.getByRole("button", { name })
        : screen.getByRole("textbox", { name });
    expect(fireEvent.keyDown(target, { key: "a", metaKey: true })).toBe(true);
  }
  expect(
    fireEvent.keyDown(page, { key: "a", metaKey: true, shiftKey: true }),
  ).toBe(true);
  expect(create).toHaveBeenCalledTimes(2);
});
