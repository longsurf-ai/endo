// Purpose: Shared code surfaces wait for one Monaco initialization and retain caller options while following app theme.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CodeEditor } from "@openchart/app/components/ui/code-editor";
import { ThemeProvider } from "@openchart/app/lib/theme/theme";

const shared = vi.hoisted(() => {
  let ready!: () => void;
  const promise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  return { promise, ready, render: vi.fn() };
});
vi.mock("@openchart/app/lib/monaco/monaco", () => ({
  monacoReady: shared.promise,
}));
vi.mock("@monaco-editor/react", () => ({
  default: (props: {
    value?: string;
    options?: { readOnly?: boolean; ariaLabel?: string };
    theme?: string;
  }) => {
    shared.render(props);
    return (
      <textarea
        aria-label={props.options?.ariaLabel}
        readOnly={props.options?.readOnly}
        value={props.value}
      />
    );
  },
}));
afterEach(() => document.documentElement.classList.remove("dark"));

test("shares initialization, read-only defaults and theme without taking over the caller's model", async () => {
  const { unmount } = render(
    <CodeEditor
      language="tea"
      value="value = close"
      options={{ readOnly: true, ariaLabel: "TeaScript" }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Opening editor");
  await act(async () => shared.ready());
  expect(await screen.findByRole("textbox", { name: "TeaScript" })).toHaveValue(
    "value = close",
  );
  expect(shared.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      language: "tea",
      theme: "Default Light+",
      options: expect.objectContaining({
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        glyphMargin: false,
        lineNumbersMinChars: 2,
      }),
    }),
  );
  act(() => document.documentElement.classList.add("dark"));
  await waitFor(() =>
    expect(shared.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "Default Dark+" }),
    ),
  );
  unmount();
});

test("does not miss a theme applied between render and subscription", async () => {
  vi.stubGlobal("matchMedia", () =>
    Object.assign(new EventTarget(), { matches: false }),
  );
  const view = render(
    <ThemeProvider theme="dark">
      <CodeEditor value="first" options={{ readOnly: true }} />
    </ThemeProvider>,
  );
  await act(async () => shared.ready());
  await waitFor(() =>
    expect(shared.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "Default Dark+" }),
    ),
  );
  view.unmount();
});
