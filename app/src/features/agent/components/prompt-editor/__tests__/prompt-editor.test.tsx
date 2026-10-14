// Purpose: Defaults hydrate without becoming edits; actual changes retain their dirty state.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import { AgentPromptEditor } from "@openchart/app/features/agent/components/prompt-editor/prompt-editor";
import type { ModelSelection } from "@openchart/app/lib/agent/client";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

const state = vi.hoisted(() => ({
  defaultModel: undefined as ModelSelection | undefined,
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent: state }),
}));
vi.mock("@openchart/app/features/agent/components/composer/composer", () => ({
  AgentComposer: ({ leading }: { leading: ReactNode }) => (
    <div>
      <ComposerPrimitive.Input aria-label="Prompt" submitMode="none" />
      {leading}
    </div>
  ),
}));
vi.mock(
  "@openchart/app/features/agent/components/composer/composer-controls",
  () => ({
    ComposerControls: ({
      onModelChange,
      onWorkspaceChange,
    }: {
      onModelChange: (value: ModelSelection) => void;
      onWorkspaceChange: (value: string) => void;
    }) => (
      <>
        <button
          onClick={() =>
            onModelChange({ providerID: "codex", modelID: "tier2" })
          }
        >
          Choose model
        </button>
        <button
          onClick={() =>
            onModelChange({ providerID: "codex", modelID: "tier1" })
          }
        >
          Default model
        </button>
        <button onClick={() => onWorkspaceChange("wsp_chosen")}>
          Choose workspace
        </button>
        <button onClick={() => onWorkspaceChange("wsp_default")}>
          Default workspace
        </button>
      </>
    ),
  }),
);
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  state.defaultModel = undefined;
});

function mount() {
  let resolveWorkspace!: (id: string) => void;
  const workspace = new Promise<string>((resolve) => {
    resolveWorkspace = resolve;
  });
  const transport = {
    url: "prompt-dirty-test",
    rpc: {
      resources: {
        workspace: { getDefault: { query: vi.fn(() => workspace) } },
      },
    },
  } as unknown as AppTransport;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const view = () => (
    <QueryClientProvider client={client}>
      <AgentPromptEditor
        transport={transport}
        initialText="Analyze the alert"
        disabled={false}
        onCancel={() => {}}
      >
        {(editor) => (
          <>
            {editor.content}
            <output aria-label="Draft state">
              {JSON.stringify({
                changed: editor.changed,
                parts: editor.partsChanged,
                model: editor.modelChanged,
                workspace: editor.workspaceChanged,
                ready: editor.ready,
              })}
            </output>
          </>
        )}
      </AgentPromptEditor>
    </QueryClientProvider>
  );
  const utils = render(view());
  return { resolveWorkspace, rerender: () => utils.rerender(view()) };
}
const draftState = () =>
  JSON.parse(screen.getByLabelText("Draft state").textContent!);

test("a new composer stays clean as the default model and workspace arrive asynchronously", async () => {
  const view = mount();
  await waitFor(() =>
    expect(screen.getByLabelText("Prompt")).toHaveValue("Analyze the alert"),
  );
  expect(draftState()).toMatchObject({
    changed: false,
    parts: false,
    model: false,
    workspace: false,
  });
  state.defaultModel = { providerID: "codex", modelID: "tier1" };
  view.rerender();
  await act(async () => view.resolveWorkspace("wsp_default"));
  await waitFor(() =>
    expect(draftState()).toEqual({
      changed: false,
      parts: false,
      model: false,
      workspace: false,
      ready: true,
    }),
  );
});

test("model, workspace and text edits are detected, including clearing an otherwise ready prompt", async () => {
  state.defaultModel = { providerID: "codex", modelID: "tier1" };
  const view = mount();
  await act(async () => view.resolveWorkspace("wsp_default"));
  await waitFor(() => expect(draftState().ready).toBe(true));
  fireEvent.click(screen.getByText("Choose model"));
  expect(draftState()).toMatchObject({ changed: true, model: true });
  fireEvent.click(screen.getByText("Default model"));
  expect(draftState().changed).toBe(false);
  fireEvent.click(screen.getByText("Choose workspace"));
  expect(draftState()).toMatchObject({ changed: true, workspace: true });
  fireEvent.click(screen.getByText("Default workspace"));
  expect(draftState().changed).toBe(false);
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "" } });
  expect(draftState()).toMatchObject({
    changed: true,
    parts: true,
    ready: false,
  });
});
