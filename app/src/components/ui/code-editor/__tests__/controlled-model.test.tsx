// Purpose: Exercise the real Monaco React adapter when it reuses a retained model.
import { act, render, waitFor } from "@testing-library/react";
import { loader, type Monaco } from "@monaco-editor/react";
import { expect, test, vi } from "vitest";
import { CodeEditor } from "@openchart/app/components/ui/code-editor";

vi.mock("@openchart/app/lib/monaco/monaco", () => ({
  monacoReady: Promise.resolve(),
}));

test("a controlled editor reopens a retained model with current text without reporting an edit", async () => {
  // Mock the native editor only. @monaco-editor/react must run its actual
  // model-reuse and effect lifecycle, which a textarea substitute cannot test.
  let text = "old disk text";
  const model = { dispose: vi.fn(), getFullModelRange: () => ({}) };
  const listeners = new Set<() => void>();
  const setValue = (value: string) => {
    text = value;
    for (const listener of listeners) listener();
  };
  const editor = {
    getModel: () => model,
    getValue: () => text,
    setValue,
    getOption: () => false,
    executeEdits: (_source: string, edits: Array<{ text: string }>) =>
      setValue(edits[0]!.text),
    pushUndoStop: vi.fn(),
    updateOptions: vi.fn(),
    saveViewState: vi.fn(),
    restoreViewState: vi.fn(),
    dispose: vi.fn(),
    onDidChangeModelContent: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  loader.config({
    monaco: {
      Uri: { parse: (path: string) => ({ path }) },
      editor: {
        getModel: () => model,
        create: () => editor,
        setTheme: vi.fn(),
        EditorOption: { readOnly: 1 },
        onDidChangeMarkers: () => ({ dispose() {} }),
      },
    } as unknown as Monaco,
  });
  const onChange = vi.fn();
  const onMount = vi.fn();
  const view = render(
    <CodeEditor
      path="file:///workspace/main.tea"
      keepCurrentModel
      value="current disk text"
      onChange={onChange}
      onMount={onMount}
    />,
  );
  await waitFor(() => expect(onMount).toHaveBeenCalledOnce());
  expect(text).toBe("current disk text");
  expect(onChange).not.toHaveBeenCalled();

  view.rerender(
    <CodeEditor
      path="file:///workspace/main.tea"
      keepCurrentModel
      value="newer disk text"
      onChange={onChange}
      onMount={onMount}
    />,
  );
  await waitFor(() => expect(text).toBe("newer disk text"));
  expect(onChange).not.toHaveBeenCalled();
  act(() => setValue("user draft"));
  expect(onChange).toHaveBeenCalledWith("user draft", undefined);
  view.unmount();
  expect(model.dispose).not.toHaveBeenCalled();

  const { unmount } = render(
    <CodeEditor
      path="file:///workspace/main.tea"
      keepCurrentModel
      value="disk after closing"
      onChange={onChange}
    />,
  );
  await waitFor(() => expect(text).toBe("disk after closing"));
  expect(onChange).toHaveBeenCalledOnce();
  unmount();
});
