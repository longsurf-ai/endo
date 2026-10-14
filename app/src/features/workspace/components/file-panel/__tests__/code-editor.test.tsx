// Purpose: The Workspace editor forwards its draft and edits to the shared Monaco editor.
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import CodeEditor from "../code-editor";

const editor = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("@openchart/app/components/ui/code-editor", () => ({
  CodeEditor: (props: {
    value: string;
    path: string;
    onChange: (value: string | undefined) => void;
  }) => {
    editor.render(props);
    return (
      <textarea
        aria-label="Code"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  },
}));

test("renders the current draft at its model path and reports edits", () => {
  const onChange = vi.fn();
  const props = {
    path: "inmemory:///view/wsp_test/notes.txt",
    workspaceId: "wsp_test",
    value: "current text",
    onChange,
  };
  const view = render(<CodeEditor {...props} />);
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue(
    "current text",
  );
  expect(editor.render).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: props.path }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), {
    target: { value: "edited" },
  });
  expect(onChange).toHaveBeenCalledWith("edited");
  view.rerender(<CodeEditor {...props} value="unsaved draft" />);
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue(
    "unsaved draft",
  );
});
