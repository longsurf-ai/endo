import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
import { findErrorToast } from "@openchart/app/testing/test-utils";
// Purpose: Exercise image input through the real assistant-ui composer and prompt conversion.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { CompleteAttachment } from "@assistant-ui/react";
import {
  AgentNewThread,
  AgentThread,
} from "@openchart/app/features/agent/components/thread/agent-thread";
import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";
import {
  type ComposerDraft,
  toPromptParts,
} from "@openchart/app/lib/prompt-converter/converter";

const agent = vi.hoisted(() => ({
  markSessionRead: { mutate: vi.fn() },
  getSession: vi.fn(),
  commands: { data: [], isPending: false, isError: false },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  // jsdom has no object URLs; the production hook's allocation and cleanup still run.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

const imageURL = "data:image/png;base64,Y2hhcnQ=";
const image: CompleteAttachment = {
  id: "image",
  type: "image",
  name: "chart.png",
  contentType: "image/png",
  status: { type: "complete" },
  content: [{ type: "image", image: imageURL }],
};

function session(messages: SessionSnapshot["messages"] = []) {
  const snapshot: SessionSnapshot = {
    messages,
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  const handle: ReturnType<SessionStore["getSession"]> = {
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
  agent.getSession.mockReturnValue(handle);
}

async function pickImage() {
  const user = userEvent.setup();
  // The upstream picker creates an unattached input on demand.
  const click = vi
    .spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(() => {});
  await user.click(screen.getByRole("button", { name: "Add Attachment" }));
  await user.upload(
    click.mock.contexts[0] as HTMLInputElement,
    new File(["chart"], "chart.png", { type: "image/png" }),
  );
  await screen.findByRole("button", { name: "Image attachment" });
  click.mockRestore();
}

test.each(["new", "existing"])(
  "sends an image without text through the %s composer",
  async (kind) => {
    session();
    const submit = vi
      .fn<(draft: ComposerDraft) => Promise<void>>()
      .mockResolvedValue(undefined);
    render(
      kind === "new" ? (
        <AgentNewThread onSubmit={submit} />
      ) : (
        <AgentThread
          sessionID="session"
          model={{ providerID: "codex" as const, modelID: "tier1" as const }}
          onSubmit={submit}
        />
      ),
    );
    await pickImage();
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(await toPromptParts(submit.mock.calls[0]![0], vi.fn())).toEqual([
      { type: "file", mime: "image/png", filename: "chart.png", url: imageURL },
    ]);
    expect(
      screen.queryByRole("button", { name: "Remove file" }),
    ).not.toBeInTheDocument();
  },
);

test("pastes and drops images into the native attachment list and removes them", async () => {
  const submit = vi.fn();
  render(<AgentNewThread onSubmit={submit} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.paste(input, {
    clipboardData: {
      files: [new File(["paste"], "paste.png", { type: "image/png" })],
    },
  });
  await screen.findByRole("button", { name: "Image attachment" });
  fireEvent.drop(input, {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["drop"], "drop.png", { type: "image/png" })],
    },
  });
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Remove file" })).toHaveLength(
      2,
    ),
  );
  for (const remove of screen.getAllByRole("button", { name: "Remove file" }))
    await userEvent.click(remove);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(submit).not.toHaveBeenCalled();
});

test("reports rejected files without replacing typed text", async () => {
  render(<AgentNewThread onSubmit={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(input, "Keep this");
  fireEvent.paste(input, {
    clipboardData: {
      files: [new File(["pdf"], "report.pdf", { type: "application/pdf" })],
    },
  });
  expect(await findErrorToast("not accepted")).toHaveTextContent(
    "not accepted",
  );
  expect(input).toHaveTextContent("Keep this");
});

test("retains completed images after rejection and restores them after Session creation", async () => {
  const submit = vi
    .fn<(draft: ComposerDraft) => Promise<void>>()
    .mockRejectedValue(new Error("Offline"));
  const view = render(<AgentNewThread onSubmit={submit} />);
  await pickImage();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(
    await screen.findByRole("button", { name: "Remove file" }),
  ).toBeVisible();
  const failedDraft = submit.mock.calls[0]![0];
  view.unmount();
  session();
  const retry = vi
    .fn<(draft: ComposerDraft) => Promise<void>>()
    .mockResolvedValue(undefined);
  render(
    <AgentThread
      sessionID="session"
      model={{ providerID: "codex" as const, modelID: "tier1" as const }}
      failedDraft={failedDraft}
      onSubmit={retry}
    />,
  );
  await screen.findByRole("button", { name: "Remove file" });
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(await toPromptParts(retry.mock.calls[0]![0], vi.fn())).toEqual([
    { type: "file", mime: "image/png", filename: "chart.png", url: imageURL },
  ]);
});

test("restores quote, text and images together without overwriting a newer draft", async () => {
  session();
  const submit = vi
    .fn<(draft: ComposerDraft) => Promise<void>>()
    .mockResolvedValue(undefined);
  const failedDraft: ComposerDraft = {
    text: "Explain",
    quote: { text: "Selected", messageId: "reply" },
    attachments: [image],
  };
  const props = {
    sessionID: "session",
    model: { providerID: "codex" as const, modelID: "tier1" as const },
    onSubmit: submit,
  };
  const view = render(<AgentThread {...props} />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "New draft",
  );
  view.rerender(<AgentThread {...props} failedDraft={failedDraft} />);
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "New draft",
  );
  expect(
    screen.queryByRole("button", { name: "Remove file" }),
  ).not.toBeInTheDocument();
  view.unmount();
  render(<AgentThread {...props} failedDraft={failedDraft} />);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(await toPromptParts(submit.mock.calls[0]![0], vi.fn())).toEqual([
    { type: "context", context: { kind: "quote", text: "Selected" } },
    { type: "text", text: "Explain" },
    { type: "file", mime: "image/png", filename: "chart.png", url: imageURL },
  ]);
});

test("renders a persisted image and opens the official preview without requiring a model", async () => {
  session([
    {
      id: "user",
      role: "user",
      content: "",
      metadata: {
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "chart.png",
            url: imageURL,
          },
        ],
      },
    },
  ]);
  render(<AgentThread sessionID="session" onSubmit={vi.fn()} />);
  expect(
    screen.getByRole("img", { name: "Attachment preview" }),
  ).toHaveAttribute("src", imageURL);
  await userEvent.click(
    screen.getByRole("button", { name: "Image attachment" }),
  );
  expect(
    screen.getByRole("dialog", { name: "Image Attachment Preview" }),
  ).toBeVisible();
});
