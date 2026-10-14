// Purpose: Keep metadata work behind hover, isolated from Markdown updates.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { AgentViewProvider } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { MarkdownLink } from "@openchart/app/features/agent/components/thread/transcript/markdown/inline-citation/inline-citation.aui";
import { MarkdownText } from "@openchart/app/features/agent/components/thread/transcript/markdown/markdown-text";
import { WorkspaceFileNavigation } from "@openchart/app/lib/workspace/workspace";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
import {
  findErrorToast,
  renderWithToaster,
  testAppHost,
} from "@openchart/app/testing/test-utils";

const convertMessage = (message: ThreadMessageLike) => message;
function CitationMessage() {
  return <MessagePrimitive.Parts components={{ Text: MarkdownText }} />;
}
function CitationMarkdown({ text, root }: { text: string; root?: string }) {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: "reply",
        role: "assistant",
        content: text,
        metadata: { custom: { workspaceRoot: root } },
      },
    ],
    convertMessage,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ Message: CitationMessage }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function harness(
  query = vi
    .fn()
    .mockResolvedValue({ title: "Page title", description: "Page summary" }),
) {
  const client = createQueryClient();
  clients.push(client);
  const iconQuery = vi.fn().mockResolvedValue(null);
  const openFile = vi.fn();
  const openPath = vi.fn().mockResolvedValue(undefined);
  const appHost = testAppHost({ openPath });
  const workspaces = vi.fn().mockResolvedValue({
    items: [
      { id: "wsp_original", root: "/workspace" },
      { id: "wsp_other", root: "/other" },
    ],
  });
  const files = vi.fn().mockResolvedValue({
    status: "ready",
    entries: [{ path: "reports/note.md" }, { path: "reports/€ note.md" }],
  });
  const transport = {
    rpc: {
      agent: { linkPreview: { get: { query } } },
      favicon: { get: { query: iconQuery } },
      resources: { workspace: { list: { query: workspaces } } },
      workspace: { listTree: { query: files } },
    },
  } as unknown as AppTransport;
  const view = {
    transport,
    session: undefined,
    model: undefined,
    pending: undefined,
    onOpen: undefined,
    workspaceId: "wsp_other",
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <AgentViewProvider value={view}>
          <WorkspaceFileNavigation.Provider value={openFile}>
            <AppHostProvider value={appHost}>{children}</AppHostProvider>
          </WorkspaceFileNavigation.Provider>
        </AgentViewProvider>
      </QueryClientProvider>
    );
  }
  return {
    query,
    iconQuery,
    client,
    openFile,
    openPath,
    workspaces,
    files,
    wrapper: Wrapper,
  };
}

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

it("renders 100 links without creating queries, then fetches only the hovered URL", async () => {
  const { query, iconQuery, client, wrapper } = harness();
  render(
    <>
      {Array.from({ length: 100 }, (_, i) => (
        <MarkdownLink
          key={i}
          href={`https://example.com/${i}`}
          data-citation-number={i + 1}
        >
          Source {i}
        </MarkdownLink>
      ))}
    </>,
    { wrapper },
  );
  expect(query).not.toHaveBeenCalled();
  expect(iconQuery).not.toHaveBeenCalled();
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  const link = screen.getByRole("link", { name: "Source 43: Source 42" });
  expect(link).toHaveTextContent("43");
  await userEvent.hover(link);
  expect(await screen.findByText("Page summary")).toBeVisible();
  expect(query).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledWith(
    { url: "https://example.com/42" },
    { signal: expect.any(AbortSignal) },
  );
  expect(link).toHaveAttribute("href", "https://example.com/42");
  expect(iconQuery).toHaveBeenCalledExactlyOnceWith(
    { hostname: "example.com" },
    { signal: expect.any(AbortSignal) },
  );
});

it("does not refetch when Markdown rerenders during an open preview", async () => {
  const { query, wrapper } = harness();
  const { rerender } = render(
    <MarkdownLink href="https://example.com" data-citation-number={1}>
      Source
    </MarkdownLink>,
    { wrapper },
  );
  await userEvent.hover(screen.getByRole("link"));
  await screen.findByText("Page summary");
  rerender(
    <MarkdownLink href="https://example.com" data-citation-number={1}>
      <strong>Updated source</strong>
    </MarkdownLink>,
  );
  expect(query).toHaveBeenCalledOnce();
  expect(screen.getByText("Page title")).toBeVisible();
});

it("keeps the original label/domain while loading and when the API fails", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const { query, wrapper } = harness(vi.fn().mockReturnValue(pending));
  render(
    <MarkdownLink href="https://example.com/report" data-citation-number={1}>
      <strong>Original</strong> report
    </MarkdownLink>,
    { wrapper },
  );
  await userEvent.hover(screen.getByRole("link"));
  expect(await screen.findByText("example.com")).toBeVisible();
  expect(screen.getByText("Original report")).toBeVisible();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByText("Original report")).toBeVisible();
  expect(query).toHaveBeenCalledOnce();
});

it("unmounts immediately and cancels the pending read on close", async () => {
  let requestSignal: AbortSignal | undefined;
  const { client, wrapper } = harness(
    vi
      .fn()
      .mockImplementation((_input, { signal }: { signal: AbortSignal }) => {
        requestSignal = signal;
        return new Promise(() => {});
      }),
  );
  render(
    <MarkdownLink href="https://example.com" data-citation-number={1}>
      Source
    </MarkdownLink>,
    {
      wrapper,
    },
  );
  const user = userEvent.setup();
  const link = screen.getByRole("link");
  await user.hover(link);
  await screen.findByText("example.com");
  await user.unhover(link);
  expect(screen.queryByText("example.com")).not.toBeInTheDocument();
  await waitFor(() => expect(requestSignal?.aborted).toBe(true));
  expect(
    client.getQueryData(["linkPreview", "https://example.com/"]),
  ).toBeUndefined();
});

it("reuses in-memory previews and host icons, while a cache miss follows the same fetch path", async () => {
  const { query, iconQuery, client, wrapper } = harness();
  const icon = "data:image/png;base64,icon-test";
  iconQuery.mockResolvedValue(icon);
  vi.stubGlobal(
    "Image",
    class {
      complete = true;
      naturalWidth = 16;
    },
  );
  render(
    <>
      <MarkdownLink href="https://example.com/one" data-citation-number={1}>
        First
      </MarkdownLink>
      <MarkdownLink href="https://example.com/two" data-citation-number={2}>
        Second
      </MarkdownLink>
    </>,
    { wrapper },
  );
  const user = userEvent.setup();
  const first = screen.getByRole("link", { name: "Source 1: First" });
  const second = screen.getByRole("link", { name: "Source 2: Second" });
  await user.hover(first);
  expect(await screen.findByText("Page summary")).toBeVisible();
  expect(await screen.findByAltText("")).toHaveAttribute("src", icon);
  await user.unhover(first);
  await user.hover(first);
  expect(screen.getByText("Page summary")).toBeVisible();
  expect(query).toHaveBeenCalledOnce();
  expect(iconQuery).toHaveBeenCalledOnce();
  await user.unhover(first);
  await user.hover(second);
  expect(await screen.findByText("Page summary")).toBeVisible();
  expect(query).toHaveBeenCalledTimes(2);
  expect(iconQuery).toHaveBeenCalledOnce();
  await user.unhover(second);
  client.clear();
  await user.hover(first);
  expect(await screen.findByText("Page summary")).toBeVisible();
  expect(query).toHaveBeenCalledTimes(3);
  expect(iconQuery).toHaveBeenCalledTimes(2);
});

it("retries unavailable metadata next hover and preserves the initial for an invalid icon", async () => {
  const { query, iconQuery, wrapper } = harness();
  query.mockResolvedValueOnce(null);
  iconQuery.mockResolvedValue("data:image/png;base64,invalid");
  vi.stubGlobal(
    "Image",
    class {
      complete = true;
      naturalWidth = 0;
    },
  );
  render(
    <MarkdownLink href="https://example.com" data-citation-number={1}>
      Source
    </MarkdownLink>,
    { wrapper },
  );
  const user = userEvent.setup();
  const link = screen.getByRole("link");
  await user.hover(link);
  expect(await screen.findByText("example.com")).toBeVisible();
  expect(screen.getByText("E")).toBeVisible();
  expect(screen.queryByAltText("")).not.toBeInTheDocument();
  await user.unhover(link);
  await user.hover(link);
  expect(await screen.findByText("Page summary")).toBeVisible();
  expect(query).toHaveBeenCalledTimes(2);
});

it("preserves Markdown labels before stable source numbers across paragraphs and streaming", async () => {
  const { query, wrapper } = harness();
  const content =
    "[First](https://example.com/one)\n\n[Second](https://example.com/two) and [Again](https://example.com/one) [Details](#details)";
  const markdown = (text: string) => <CitationMarkdown text={text} />;
  const { rerender } = render(markdown(content), { wrapper });
  expect(screen.getByText("First")).toBeVisible();
  expect(screen.getByText("Second")).toBeVisible();
  expect(screen.getByText("Again")).toBeVisible();
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "1",
    "2",
    "1",
    "Details",
  ]);
  expect(query).not.toHaveBeenCalled();
  rerender(markdown(`${content}\n\n[Third](https://example.com/three)`));
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "1",
    "2",
    "1",
    "Details",
    "3",
  ]);
  await userEvent.hover(screen.getByRole("link", { name: "Source 2: Second" }));
  expect(await screen.findByText("Page summary")).toBeVisible();
  expect(query).toHaveBeenCalledExactlyOnceWith(
    { url: "https://example.com/two" },
    { signal: expect.any(AbortSignal) },
  );
});

it("leaves fragments and other link schemes as ordinary links", async () => {
  const { query, wrapper } = harness();
  render(
    <>
      <MarkdownLink href="#details">Details</MarkdownLink>
      <MarkdownLink href="mailto:hello@example.com">Email</MarkdownLink>
    </>,
    { wrapper },
  );
  await userEvent.hover(screen.getByRole("link", { name: "Details" }));
  await userEvent.hover(screen.getByRole("link", { name: "Email" }));
  expect(query).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute(
    "href",
    "mailto:hello@example.com",
  );
});

it.each([
  "reports/note.md",
  "./reports/note.md",
  "/workspace/reports/note.md",
  "file:///workspace/reports/note.md",
  "/workspace/reports/note.md:12:3",
  "reports/note.md#L12",
])(
  "opens %s in the reply's Workspace even when the composer selects another",
  async (href) => {
    const { wrapper, openFile, openPath, workspaces, files, query } = harness();
    render(<CitationMarkdown root="/workspace" text={`[Report](${href})`} />, {
      wrapper,
    });
    const chip = await screen.findByRole("button", { name: "file: note.md" });
    expect(chip).toHaveTextContent("note.md");
    expect(chip).toHaveAttribute("data-slot", "directive-text-chip");
    expect(chip).toHaveAttribute("data-directive-type", "file");
    expect(chip).toHaveAttribute(
      "data-directive-id",
      "/workspace/reports/note.md",
    );
    expect(chip).toHaveAttribute("title", "/workspace/reports/note.md");
    expect(screen.queryByText("Report")).not.toBeInTheDocument();
    expect(workspaces).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
    await userEvent.click(chip);
    await waitFor(() =>
      expect(openFile).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "wsp_original",
        path: "reports/note.md",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
    expect(files).toHaveBeenCalledWith(
      { workspaceId: "wsp_original" },
      { signal: expect.any(AbortSignal) },
    );
    expect(query).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  },
);

it("opens percent-encoded filenames", async () => {
  const { wrapper, openFile } = harness();
  render(
    <CitationMarkdown
      root="/workspace"
      text="[Report](reports/%E2%82%AC%20note.md)"
    />,
    { wrapper },
  );
  const chip = await screen.findByRole("button", {
    name: "file: € note.md",
  });
  expect(chip).toHaveAttribute("title", "/workspace/reports/€ note.md");
  const user = userEvent.setup();
  await user.tab();
  expect(chip).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(openFile).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "wsp_original",
      path: "reports/€ note.md",
    }),
  );
});

it("keeps invalid paths and remote file URLs as plain text", async () => {
  const { wrapper, openFile, openPath } = harness();
  const paths = [
    "file://remote/workspace/reports/note.md",
    "//remote/reports/note.md",
    "reports/bad%ZZ.md",
    "reports/bad%00.md",
    "javascript:alert(1)",
  ];
  render(
    <CitationMarkdown
      root="/workspace"
      text={[
        "[Allowed](reports/note.md)",
        ...paths.map((path, i) => `[File ${i}](${path})`),
      ].join("\n\n")}
    />,
    { wrapper },
  );
  await screen.findByRole("button", { name: "file: note.md" });
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  for (const [i] of paths.entries()) {
    const label = screen.getByText(`File ${i}`);
    expect(
      screen.queryByRole("button", { name: `File ${i}` }),
    ).not.toBeInTheDocument();
    await userEvent.click(label);
  }
  expect(openFile).not.toHaveBeenCalled();
  expect(openPath).not.toHaveBeenCalled();
});

it.each([
  ["/other/reports/note.md", "/other/reports/note.md"],
  ["../other/reports/note.md", "/other/reports/note.md"],
  ["/workspace-other/reports/note.md", "/workspace-other/reports/note.md"],
  ["file:///other/reports/note.md:12:3", "/other/reports/note.md"],
  ["../other/%E2%82%AC%20note.md#L12", "/other/€ note.md"],
  ["reports/missing.md", "/workspace/reports/missing.md"],
  ["script.ts", "/workspace/script.ts"],
  [".hidden/note.md", "/workspace/.hidden/note.md"],
])(
  "opens %s with the system when it is not in the Workspace index",
  async (href, path) => {
    const { wrapper, openPath, openFile } = harness();
    render(<CitationMarkdown root="/workspace" text={`[Report](${href})`} />, {
      wrapper,
    });
    const chip = screen.getByRole("button", {
      name: `file: ${path.slice(path.lastIndexOf("/") + 1)}`,
    });
    expect(chip).toHaveAttribute("data-slot", "directive-text-chip");
    expect(chip).toHaveAttribute("title", path);
    expect(openPath).not.toHaveBeenCalled();
    await userEvent.click(chip);
    await waitFor(() => expect(openPath).toHaveBeenCalledExactlyOnceWith(path));
    expect(openFile).not.toHaveBeenCalled();
  },
);

it("requires a saved cwd only for relative file paths", async () => {
  const { wrapper, openPath, workspaces } = harness();
  render(
    <CitationMarkdown text="[Relative](reports/note.md) [Absolute](/other/note.md)" />,
    { wrapper },
  );
  expect(screen.getByText("Relative")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "file: note.md" }));
  await waitFor(() =>
    expect(openPath).toHaveBeenCalledExactlyOnceWith("/other/note.md"),
  );
  expect(workspaces).not.toHaveBeenCalled();
});

it("opens files from a forgotten Workspace with the system", async () => {
  const { wrapper, openPath, files } = harness();
  render(
    <CitationMarkdown root="/forgotten" text="[Report](reports/note.md)" />,
    { wrapper },
  );
  await userEvent.click(screen.getByRole("button", { name: "file: note.md" }));
  await waitFor(() =>
    expect(openPath).toHaveBeenCalledExactlyOnceWith(
      "/forgotten/reports/note.md",
    ),
  );
  expect(files).not.toHaveBeenCalled();
});

it("waits for the Workspace index without opening externally or accepting another click", async () => {
  const { wrapper, openPath, openFile, files } = harness();
  let resolve!: (value: unknown) => void;
  files.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(
    <CitationMarkdown root="/workspace" text="[Report](reports/note.md)" />,
    { wrapper },
  );
  const chip = screen.getByRole("button", { name: "file: note.md" });
  await userEvent.click(chip);
  await waitFor(() => expect(chip).toBeDisabled());
  await userEvent.click(chip);
  expect(openPath).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
  await act(async () =>
    resolve({ status: "ready", entries: [{ path: "reports/note.md" }] }),
  );
  await waitFor(() =>
    expect(openFile).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "wsp_original",
      path: "reports/note.md",
    }),
  );
  expect(openPath).not.toHaveBeenCalled();
});

it.each(["registry error", "index error", "loading", "missing", "unavailable"])(
  "reports %s without falling back to a native open",
  async (failure) => {
    const { wrapper, workspaces, files, openPath, openFile } = harness();
    if (failure === "registry error")
      workspaces.mockRejectedValueOnce(new Error("Registry failed"));
    else if (failure === "index error")
      files.mockRejectedValueOnce(new Error("Index failed"));
    else files.mockResolvedValueOnce({ status: failure });
    renderWithToaster(
      <CitationMarkdown root="/workspace" text="[Report](reports/note.md)" />,
      {
        wrapper,
      },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "file: note.md" }),
    );
    expect(await findErrorToast()).toBeVisible();
    expect(openPath).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  },
);

it("reports a native open failure without retrying it", async () => {
  const { wrapper, openPath } = harness();
  openPath.mockRejectedValueOnce(new Error("File does not exist"));
  renderWithToaster(
    <CitationMarkdown root="/workspace" text="[Report](/other/note.md)" />,
    { wrapper },
  );
  await userEvent.click(screen.getByRole("button", { name: "file: note.md" }));
  expect(await findErrorToast("File does not exist")).toBeVisible();
  expect(openPath).toHaveBeenCalledOnce();
});
