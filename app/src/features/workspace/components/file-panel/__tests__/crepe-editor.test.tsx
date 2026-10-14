// Purpose: Exercise real Crepe transactions, lossless opening, draft timing and source fallback.
import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import CrepeEditor from "@openchart/app/features/workspace/components/file-panel/crepe-editor";

const editors = vi.hoisted(() => [] as Crepe[]);
vi.mock("@milkdown/crepe", async (original) => {
  const actual = await original<typeof import("@milkdown/crepe")>();
  return {
    ...actual,
    Crepe: class extends actual.Crepe {
      constructor(...args: ConstructorParameters<typeof Crepe>) {
        super(...args);
        editors.push(this);
      }
    },
  };
});
beforeEach(() => {
  editors.splice(0);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

async function setup(value = "# Original\n\n*  item\n") {
  const props = {
    value,
    onChange: vi.fn(),
    onUnavailable: vi.fn(),
  };
  const utils = render(
    <StrictMode>
      <CrepeEditor {...props} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Markdown editor" }),
    ).toHaveAttribute("contenteditable", "true"),
  );
  const crepe = editors.at(-1)!;
  const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  return { ...utils, props, crepe, view };
}

test("opening preserves original bytes; edits arrive immediately and undo restores those bytes", async () => {
  const { props, view } = await setup();
  expect(
    screen.getAllByRole("textbox", { name: "Markdown editor" }),
  ).toHaveLength(1);
  expect(props.onChange).not.toHaveBeenCalled();
  act(() => view.dispatch(view.state.tr.insertText("Edited ", 1)));
  expect(props.onChange).toHaveBeenLastCalledWith(
    expect.stringContaining("# Edited Original"),
  );
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(props.onChange).toHaveBeenLastCalledWith(props.value);
  expect(props.onUnavailable).not.toHaveBeenCalled();
});

test("draft echoes preserve selection and undo; new disk text replaces the document without emitting edits", async () => {
  const { props, view, crepe, rerender } = await setup();
  act(() => view.dispatch(view.state.tr.insertText("Edited ", 1)));
  const draft = props.onChange.mock.lastCall![0];
  const selection = view.state.selection;
  rerender(
    <StrictMode>
      <CrepeEditor {...props} value={draft} />
    </StrictMode>,
  );
  expect(view.state.selection.eq(selection)).toBe(true);
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(props.onChange).toHaveBeenLastCalledWith(props.value);
  props.onChange.mockClear();
  rerender(
    <StrictMode>
      <CrepeEditor {...props} value={"# From disk\n"} />
    </StrictMode>,
  );
  expect(crepe.getMarkdown()).toBe("# From disk\n");
  expect(props.onUnavailable).not.toHaveBeenCalled();
  expect(props.onChange).not.toHaveBeenCalled();
});

test.each([
  "---\ntitle: Keep this\n---\n\n# Document\n",
  "| Item | Value |\n| --- | --- |\n| A | <br /> |\n",
  "Read [reference][link].\n\n[link]: https://example.com\n",
])(
  "unsupported formatting switches to source without changing the draft: %s",
  async (value) => {
    const onChange = vi.fn();
    const onUnavailable = vi.fn();
    render(
      <CrepeEditor
        value={value}
        onChange={onChange}
        onUnavailable={onUnavailable}
      />,
    );
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
  },
);

test("GFM tables, task lists and code blocks remain visually editable", async () => {
  const { props } = await setup(
    '# Notes\n\n- [ ] Review\n- [x] Done\n\n| Item | Value |\n| --- | --- |\n| A | 1 |\n\n```typescript\nconst message = "hello";\n```\n',
  );
  expect(
    screen.getByRole("columnheader", { name: "Item" }),
  ).toBeInTheDocument();
  expect(props.onUnavailable).not.toHaveBeenCalled();
  expect(props.onChange).not.toHaveBeenCalled();
});

test("empty table cells remain visually editable and save without placeholders", async () => {
  const { props, view } = await setup(
    "|   | Total |\n| --- | --- |\n| Cost |   |\n",
  );
  expect(props.onUnavailable).not.toHaveBeenCalled();
  act(() => view.dispatch(view.state.tr.insertText("Edited ", 4)));
  expect(props.onChange).toHaveBeenLastCalledWith(
    expect.stringMatching(/^\| Edited\s+\| Total \|\n.*\| Cost\s+\|\s+\|\n$/s),
  );
});
