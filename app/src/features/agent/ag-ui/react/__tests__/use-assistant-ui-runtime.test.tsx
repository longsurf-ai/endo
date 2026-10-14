// Purpose: Restored drafts cannot submit before their conversation is ready.
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ModelSelection } from "@openchart/app/lib/agent/client";
import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";
import type { ComposerDraft } from "@openchart/app/lib/prompt-converter/converter";
import {
  useAssistantUiRuntime,
  useComposerRuntime,
} from "@openchart/app/features/agent/ag-ui/react/use-assistant-ui-runtime";

const draft: ComposerDraft = {
  text: "Modify the indicator in @library-smoke.tea: ",
  quote: undefined,
  attachments: [],
};
const model: ModelSelection = { providerID: "codex", modelID: "tier1" };

function Composer() {
  return (
    <ComposerPrimitive.Root>
      <ComposerPrimitive.Input aria-label="Message" submitMode="enter" />
      <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}

test("blocks failed-handoff retries until observation, model and submission are ready, retaining the original draft", async () => {
  let snapshot: SessionSnapshot = {
    messages: [],
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: true,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const session: ReturnType<SessionStore["getSession"]> = {
    id: "handoff",
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadOlder: vi.fn(),
    submit: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    replyQuestion: vi.fn(),
    replyPermission: vi.fn(),
    dispose: vi.fn(),
  };
  const agent = { getSession: () => session };
  const submit = vi
    .fn<(draft: ComposerDraft) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Admission unavailable"))
    .mockResolvedValue(undefined);
  function Conversation(props: {
    model?: ModelSelection;
    submitting?: boolean;
  }) {
    const { runtime } = useAssistantUiRuntime({
      agent,
      sessionID: session.id,
      onSubmit: submit,
      failedDraft: draft,
      ...props,
    });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Composer />
      </AssistantRuntimeProvider>
    );
  }
  const user = userEvent.setup();
  const view = render(<Conversation model={model} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(input).toHaveValue(draft.text));
  expect(input).toBeDisabled();
  expect(send).toBeDisabled();
  await user.click(send);
  expect(submit).not.toHaveBeenCalled();

  view.rerender(<Conversation />);
  act(() => {
    snapshot = { ...snapshot, loading: false };
    listeners.forEach((listener) => listener());
  });
  expect(send).toBeDisabled();
  expect(input).toHaveValue(draft.text);
  view.rerender(<Conversation model={model} submitting />);
  expect(send).toBeDisabled();
  expect(submit).not.toHaveBeenCalled();

  view.rerender(<Conversation model={model} />);
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(draft));
  await waitFor(() => expect(input).toHaveValue(draft.text));
  await user.click(send);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit).toHaveBeenLastCalledWith(draft);
  await waitFor(() => expect(input).toHaveValue(""));
  view.unmount();
  expect(listeners.size).toBe(0);
});

test("standalone drafts honor disabled sending separately from editable send-disabled state", async () => {
  const submit = vi
    .fn<(draft: ComposerDraft) => Promise<void>>()
    .mockResolvedValue(undefined);
  function Standalone(props: { disabled?: boolean; sendDisabled?: boolean }) {
    const runtime = useComposerRuntime({
      initialDraft: draft,
      onSubmit: submit,
      ...props,
    });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Composer />
      </AssistantRuntimeProvider>
    );
  }
  const user = userEvent.setup();
  const view = render(<Standalone disabled />);
  const input = screen.getByRole("textbox", { name: "Message" });
  const send = screen.getByRole("button", { name: "Send" });
  expect(input).toHaveValue(draft.text);
  expect(input).toBeDisabled();
  expect(send).toBeDisabled();
  await user.click(send);
  expect(submit).not.toHaveBeenCalled();

  view.rerender(<Standalone sendDisabled />);
  expect(input).toBeEnabled();
  expect(send).toBeDisabled();
  await user.type(input, "Use a shorter length{Enter}");
  expect(submit).not.toHaveBeenCalled();
  view.rerender(<Standalone />);
  await user.click(send);
  await waitFor(() =>
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      ...draft,
      text: `${draft.text}Use a shorter length`,
    }),
  );
});
