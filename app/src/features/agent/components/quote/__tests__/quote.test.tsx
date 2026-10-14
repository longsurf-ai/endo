// Purpose: Exercise real assistant-ui selection, draft ownership, and structured submission.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";
import { AgentThread } from "@openchart/app/features/agent/components/thread/agent-thread";
import {
  toPromptParts,
  type ComposerDraft,
  type PromptParts,
} from "@openchart/app/lib/prompt-converter/converter";

const agent = vi.hoisted(() => ({
  markSessionRead: { mutate: vi.fn() },
  getSession: vi.fn(),
  commands: { data: [], isPending: false, isError: false },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));

// jsdom supplies real DOM selection but no geometry or scrolling.
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 200, height: 20 }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

function renderThread(
  onSubmit = vi
    .fn<(parts: PromptParts) => Promise<void>>()
    .mockResolvedValue(undefined),
  failedDraft?: ComposerDraft,
) {
  const snapshot: SessionSnapshot = {
    messages: [
      { id: "question", role: "user", content: "Earlier question" },
      {
        id: "reply",
        role: "assistant",
        content: "Revenue grew.\n\nMargins improved.",
      },
      { id: "other", role: "assistant", content: "A second reply." },
      {
        id: "tool",
        role: "assistant",
        toolCalls: [
          {
            id: "lookup",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      {
        id: "tool-result",
        role: "tool",
        toolCallId: "lookup",
        content: "Found prices",
      },
    ],
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  const session: ReturnType<SessionStore["getSession"]> = {
    id: "session",
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    submit: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    replyQuestion: vi.fn(),
    replyPermission: vi.fn(),
    dispose: vi.fn(),
  };
  agent.getSession.mockReturnValue(session);
  render(
    <AgentThread
      sessionID="session"
      model={{ providerID: "codex" as const, modelID: "tier1" as const }}
      onSubmit={async (draft) =>
        onSubmit(
          await toPromptParts(draft, async () => {
            throw new Error("Unexpected command");
          }),
        )
      }
      failedDraft={failedDraft}
    />,
  );
  return { onSubmit };
}

function selectText(start: HTMLElement, end = start) {
  act(() => {
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  fireEvent.mouseUp(document);
}

async function quoteText(text: string) {
  selectText(await screen.findByText(text));
  await userEvent.click(await screen.findByRole("button", { name: "Quote" }));
}

test("quotes selected text into the official tile without changing the draft, then sends both", async () => {
  const { onSubmit } = renderThread();
  const input = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(input, "Explain this");
  selectText(
    await screen.findByText("Revenue grew."),
    screen.getByText("Margins improved."),
  );
  const quote = await screen.findByRole("button", {
    name: "Quote",
  });
  expect(screen.getByRole("button", { name: "Dig in" })).toBeDisabled();
  await userEvent.click(quote);
  expect(
    await screen.findByRole("button", { name: "Dismiss quote" }),
  ).toBeVisible();
  expect(input).toHaveTextContent("Explain this");
  expect(window.getSelection()?.isCollapsed).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
      {
        type: "context",
        context: { kind: "quote", text: "Revenue grew.\nMargins improved." },
      },
      { type: "text", text: "Explain this" },
    ]),
  );
  expect(input).toHaveTextContent(/^$/);
  expect(
    screen.queryByRole("button", { name: "Dismiss quote" }),
  ).not.toBeInTheDocument();
});

test("replaces and dismisses a quote without discarding the typed draft", async () => {
  const { onSubmit } = renderThread();
  const input = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(input, "Keep this draft");
  await quoteText("Revenue grew.");
  await quoteText("A second reply.");
  expect(screen.getAllByText("A second reply.")).toHaveLength(2);
  expect(screen.getAllByText("Revenue grew.")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Dismiss quote" }));
  expect(input).toHaveTextContent("Keep this draft");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
    { type: "text", text: "Keep this draft" },
  ]);
});

test("restores the quote and draft after rejection and sends the quote only once on retry", async () => {
  const onSubmit = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(undefined);
  renderThread(onSubmit);
  const input = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(input, "Explain this");
  await quoteText("Revenue grew.");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(input).toHaveTextContent("Explain this"));
  expect(screen.getByRole("button", { name: "Dismiss quote" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  for (const [parts] of onSubmit.mock.calls)
    expect(parts).toEqual([
      { type: "context", context: { kind: "quote", text: "Revenue grew." } },
      { type: "text", text: "Explain this" },
    ]);
});

test("restores a failed structured draft after the conversation remounts", async () => {
  const { onSubmit } = renderThread(undefined, {
    text: "Retry after returning",
    quote: { text: "Revenue grew.", messageId: "reply" },
    attachments: [],
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Retry after returning",
    ),
  );
  expect(screen.getByRole("button", { name: "Dismiss quote" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
    { type: "context", context: { kind: "quote", text: "Revenue grew." } },
    { type: "text", text: "Retry after returning" },
  ]);
});

test("dismisses the selection toolbar on scrolling and ignores cross-message selections", async () => {
  renderThread();
  selectText(await screen.findByText("Revenue grew."));
  expect(
    await screen.findByRole("toolbar", { name: "Selected text actions" }),
  ).toBeVisible();
  fireEvent.scroll(document);
  expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  selectText(
    screen.getByText("Revenue grew."),
    screen.getByText("A second reply."),
  );
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
});

test.each(["Earlier question", "lookup"])(
  "does not quote user messages or tool UI: %s",
  async (text) => {
    renderThread();
    selectText(await screen.findByText(text));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  },
);
