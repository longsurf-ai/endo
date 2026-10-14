// Purpose: All editor instances share one initialization failure notification.
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { toast } from "sonner";
import { CodeEditor } from "@openchart/app/components/ui/code-editor";
import {
  findErrorToast,
  renderWithToaster,
} from "@openchart/app/testing/test-utils";

const initialization = vi.hoisted(() => {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  return { reject, start: vi.fn(() => promise) };
});

vi.mock("@monaco-editor/react", () => ({ default: () => null, loader: {} }));
vi.mock("monaco-editor", () => ({}));
vi.mock("monaco-languageclient/vscodeApiWrapper", () => ({
  MonacoVscodeApiWrapper: class {
    start = initialization.start;
  },
}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {},
}));
vi.mock(
  "@codingame/monaco-vscode-standalone-typescript-language-features/worker?worker",
  () => ({ default: class {} }),
);
vi.mock(
  "@codingame/monaco-vscode-textmate-service-override/worker?worker",
  () => ({
    default: class {},
  }),
);
vi.mock("@codingame/monaco-vscode-standalone-languages", () => ({}));
vi.mock(
  "@codingame/monaco-vscode-standalone-typescript-language-features",
  () => ({}),
);
vi.mock("@openchart/app/lib/monaco/grammars", () => ({
  grammarsReady: vi.fn().mockResolvedValue(undefined),
}));

test("one failed initialization reports once across multiple editors and remounts", async () => {
  const utils = renderWithToaster(
    <>
      <CodeEditor />
      <CodeEditor />
    </>,
  );
  await act(async () => initialization.reject(new Error("Theme unavailable")));

  expect(initialization.start).toHaveBeenCalledOnce();
  expect(await findErrorToast("Theme unavailable")).toHaveTextContent(
    "Couldn’t start the code editor",
  );
  expect(toast.getToasts()).toHaveLength(1);
  expect(screen.getAllByRole("status")).toHaveLength(2);

  await act(async () => {
    toast.dismiss("code-editor-start");
  });
  utils.rerender(<CodeEditor key="reopened" />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Reload the app"),
  );
  expect(toast.getToasts()).toHaveLength(0);
});
