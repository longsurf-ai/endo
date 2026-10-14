import {
  renderWithToaster as render,
  testAppHost,
} from "@openchart/app/testing/test-utils";
import { findErrorToast } from "@openchart/app/testing/test-utils";
import userEvent from "@testing-library/user-event";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
// Purpose: Verify draft preservation, disk-hash saves, the breadcrumb and each toolbar's file actions independently of Monaco's browser runtime.
import { useState } from "react";
import { QueryClientProvider, useMutation } from "@tanstack/react-query";
import {
  fireEvent,
  screen,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import type { IDockviewPanelProps } from "dockview-react";
import { createTransport } from "@openchart/app/lib/transport/transport";
import {
  workspaceFileQueryOptions,
  WorkspaceFileActions,
  WorkspaceFileMerge,
} from "@openchart/app/lib/workspace/workspace";
import { WorkspaceContext } from "@openchart/app/features/workspace/components/context";
import {
  FilePanel,
  type FilePanelParams,
} from "@openchart/app/features/workspace/components/file-panel/file-panel";

const rpc = vi.hoisted(() => ({
  resources: {
    workspace: { get: { query: vi.fn() } },
  },
  workspace: {
    read: { query: vi.fn() },
    write: { mutate: vi.fn() },
    listDirectory: { query: vi.fn() },
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
vi.mock(
  "@openchart/app/features/workspace/components/file-panel/code-editor",
  () => ({
    default: ({
      value,
      onChange,
      readOnly,
      wordWrap,
    }: {
      value: string;
      readOnly?: boolean;
      wordWrap?: boolean;
      onChange: (value: string) => void;
    }) => (
      <textarea
        aria-label="Code"
        readOnly={readOnly}
        wrap={wordWrap ? "soft" : "off"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
    ),
  }),
);
vi.mock(
  "@openchart/app/features/workspace/components/file-panel/crepe-editor",
  () =>
    import("@openchart/app/features/workspace/components/file-panel/code-editor"),
);
// jsdom has no WASM or canvas; the stand-in shows what OOXML would receive.
vi.mock(
  "@openchart/app/features/workspace/components/file-panel/office-viewer",
  () => ({
    default: ({
      bytes,
      format,
      onError,
    }: {
      bytes: Uint8Array;
      format: string;
      onError: (error: Error) => void;
    }) => (
      <div role="document" aria-label={`${format} viewer`}>
        <output>{new TextDecoder().decode(bytes)}</output>
        <button type="button" onClick={() => onError(new Error("corrupt"))}>
          Fail
        </button>
      </div>
    ),
  }),
);
vi.mock(
  "@openchart/app/features/workspace/components/file-panel/pdf-preview",
  () => ({
    default: ({ url }: { url: string }) => <iframe title="PDF" src={url} />,
  }),
);
const disk = (text: string, path = "main.tea") => ({
  entry: { path, hash: text },
  mediaType: "text/plain",
  readOnly: false,
  base64: Buffer.from(text, "utf8").toString("base64"),
});
const blobs = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };
const submitMerge =
  vi.fn<(workspaceId: string, prompt: string) => Promise<void>>();
/** Re-renders the panel with merged params on every update, like Dockview. */
function Panel({
  api,
  initial,
  containerApi,
}: {
  api: { updateParameters: (next: Partial<FilePanelParams>) => void };
  initial: FilePanelParams;
  containerApi: unknown;
}) {
  const [params, setParams] = useState(initial);
  const [merging] = useState(() => ({
    ...api,
    updateParameters: (next: Partial<FilePanelParams>) => {
      api.updateParameters(next);
      setParams((current) => ({ ...current, ...next }));
    },
  }));
  return (
    <FilePanel
      {...({
        api: merging,
        params,
        containerApi,
      } as unknown as IDockviewPanelProps<FilePanelParams>)}
    />
  );
}
function setup(
  file = disk("original"),
  {
    workspaceId = "wsp_test",
    extraActions = null,
  }: {
    workspaceId?: string;
    extraActions?: Parameters<typeof WorkspaceFileActions.Provider>[0]["value"];
  } = {},
) {
  rpc.resources.workspace.get.query.mockResolvedValue({ root: "/workspace" });
  rpc.workspace.read.query.mockResolvedValue(file);
  const client = createQueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const transport = createTransport({ origin: "http://127.0.0.1:41000" });
  const visibility = new Set<(event: { isVisible: boolean }) => void>();
  const api = {
    id: `${workspaceId}/${file.entry.path}`,
    updateParameters: vi.fn(),
    setTitle: vi.fn(),
    isVisible: true,
    onDidVisibilityChange: (
      listener: (event: { isVisible: boolean }) => void,
    ) => {
      visibility.add(listener);
      return { dispose: () => visibility.delete(listener) };
    },
  };
  const containerApi = { getPanel: vi.fn(), addPanel: vi.fn() };
  const saves = new Map<string, () => Promise<void>>();
  const host = testAppHost({
    openPath: vi.fn(async () => {}),
    revealPath: vi.fn(async () => {}),
  });
  const view = render(
    <AppHostProvider value={host}>
      <QueryClientProvider client={client}>
        <WorkspaceContext.Provider
          value={{
            transport,
            saves: { current: saves },
            instanceId: "test",
            collapsible: false,
            dark: false,
          }}
        >
          <WorkspaceFileMerge.Provider value={submitMerge}>
            <WorkspaceFileActions.Provider value={extraActions}>
              <Panel
                api={api}
                initial={{ workspaceId, path: file.entry.path }}
                containerApi={containerApi}
              />
            </WorkspaceFileActions.Provider>
          </WorkspaceFileMerge.Provider>
        </WorkspaceContext.Provider>
      </QueryClientProvider>
    </AppHostProvider>,
  );
  return {
    client,
    transport,
    api,
    hide: () =>
      act(() =>
        visibility.forEach((listener) => listener({ isVisible: false })),
      ),
    containerApi,
    saves,
    host,
    user: userEvent.setup(),
    cleanup: () => {
      view.unmount();
      client.clear();
    },
  };
}
async function menuItems(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "More file actions" }),
  );
  return (await screen.findAllByRole("menuitem")).map((item) =>
    item.textContent?.trim(),
  );
}
beforeEach(() => {
  // Previews create Blob URLs, which jsdom does not implement.
  blobs.createObjectURL.mockReturnValue("blob:preview");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = blobs.createObjectURL;
      static revokeObjectURL = blobs.revokeObjectURL;
    },
  );
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  ["main.tea", "ctrlKey", "wsp_test"],
  ["main.tea", "ctrlKey", "wsp_research"],
  ["notes.md", "metaKey", "wsp_test"],
  ["NOTES.MD", "ctrlKey", "wsp_test"],
  ["notes.markdown", "metaKey", "wsp_test"],
])(
  "decodes UTF-8 and saves %s via %s+S in %s",
  async (path, modifier, workspaceId) => {
    const original = "// Unicode € 🌍\r\nclose";
    const { cleanup } = setup(disk(original, path), { workspaceId });
    await waitFor(() =>
      expect(rpc.workspace.read.query).toHaveBeenCalledWith(
        { workspaceId, path },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    const editor = await screen.findByRole("textbox", { name: "Code" });
    expect(editor).toHaveValue(original.replaceAll("\r\n", "\n"));
    const edited = "// Edited ✅\nopen";
    rpc.workspace.write.mutate.mockResolvedValue(disk(edited, path).entry);
    rpc.workspace.read.query.mockResolvedValue(disk(edited, path));
    fireEvent.change(editor, { target: { value: edited } });
    expect(fireEvent.keyDown(editor, { key: "s", [modifier]: true })).toBe(
      false,
    );
    await waitFor(() =>
      expect(rpc.workspace.write.mutate).toHaveBeenCalledWith({
        workspaceId,
        path,
        text: edited,
        expected: original,
      }),
    );
    cleanup();
  },
);

test("invalid UTF-8 fails visibly instead of opening lossy editable text", async () => {
  const { cleanup } = setup({ ...disk(""), base64: "/w==" });
  await findErrorToast();
  expect(
    screen.queryByRole("textbox", { name: "Code" }),
  ).not.toBeInTheDocument();
  expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
  cleanup();
});

test.each([
  ["chart.PNG", "image/png"],
  ["report.pdf", "application/pdf"],
  ["fed-presser.mp3", "audio/mpeg"],
  ["fed-presser.mp4", "video/mp4"],
])(
  "previews %s through the shared read API and releases its Blob URL",
  async (path, mediaType) => {
    const { cleanup } = setup({
      entry: { path, hash: "binary-hash" },
      mediaType,
      readOnly: false,
      base64: "AP8=",
    });
    const preview =
      mediaType === "application/pdf"
        ? await screen.findByTitle("PDF")
        : mediaType.startsWith("image/")
          ? await screen.findByRole("img", { name: path })
          : await screen.findByLabelText(path);
    if (!mediaType.startsWith("image/") && mediaType !== "application/pdf")
      expect(preview.tagName).toBe(
        mediaType.startsWith("audio/") ? "AUDIO" : "VIDEO",
      );
    expect(preview).toHaveAttribute("src", "blob:preview");
    expect(rpc.workspace.read.query).toHaveBeenCalledWith(
      { workspaceId: "wsp_test", path },
      { signal: expect.any(AbortSignal) },
    );
    expect(blobs.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: mediaType, size: 2 }),
    );
    cleanup();
    expect(blobs.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  },
);

test("audio pauses when its tab is hidden", async () => {
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const { hide, cleanup } = setup({
    entry: { path: "fed-presser.mp3", hash: "binary-hash" },
    mediaType: "audio/mpeg",
    readOnly: false,
    base64: "AP8=",
  });
  await screen.findByLabelText("fed-presser.mp3");
  expect(pause).not.toHaveBeenCalled();
  hide();
  expect(pause).toHaveBeenCalledOnce();
  cleanup();
  pause.mockRestore();
});

test.each(["main.tea", "notes.md"])(
  "external changes preserve %s draft; Save focuses the banner and discard loads disk",
  async (path) => {
    const { client, transport, api, cleanup } = setup(disk("original", path));
    const editor = await screen.findByRole("textbox", { name: "Code" });
    fireEvent.change(editor, { target: { value: "draft" } });
    await waitFor(() =>
      expect(api.updateParameters).toHaveBeenLastCalledWith({
        dirty: true,
        saving: false,
      }),
    );
    rpc.workspace.read.query.mockResolvedValue(disk("external", path));
    await act(() =>
      client.invalidateQueries({
        queryKey: workspaceFileQueryOptions(transport, "wsp_test", path)
          .queryKey,
      }),
    );
    expect(editor).toHaveValue("draft");
    const discard = await screen.findByRole("button", {
      name: "Discard edits and reload",
    });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(discard).toHaveFocus();
    expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
    expect(editor).toHaveValue("draft");
    fireEvent.click(discard);
    await waitFor(() => expect(editor).toHaveValue("external"));
    expect(
      screen.queryByRole("button", { name: "Discard edits and reload" }),
    ).not.toBeInTheDocument();
    expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
    cleanup();
  },
);

test("clean files follow disk updates without a conflict banner", async () => {
  const { client, transport, cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  rpc.workspace.read.query.mockResolvedValue(disk("external"));
  await act(() =>
    client.invalidateQueries({
      queryKey: workspaceFileQueryOptions(transport, "wsp_test", "main.tea")
        .queryKey,
    }),
  );
  await waitFor(() => expect(editor).toHaveValue("external"));
  expect(
    screen.queryByRole("button", { name: "Merge with AI" }),
  ).not.toBeInTheDocument();
  cleanup();
});

test("a draft survives its disk copy turning into bytes and returns as a conflict", async () => {
  const { client, transport, cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  fireEvent.change(editor, { target: { value: "draft" } });
  const refresh = () =>
    act(() =>
      client.invalidateQueries({
        queryKey: workspaceFileQueryOptions(transport, "wsp_test", "main.tea")
          .queryKey,
      }),
    );
  rpc.workspace.read.query.mockResolvedValue({
    ...disk("binary"),
    mediaType: "application/octet-stream",
    base64: Buffer.from([0, 255]).toString("base64"),
  });
  await refresh();
  // The editor stays mounted and reports the undecodable bytes.
  await screen.findByText("Couldn’t open main.tea");
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("draft");
  rpc.workspace.read.query.mockResolvedValue(disk("external"));
  await refresh();
  await screen.findByRole("button", { name: "Merge with AI" });
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("draft");
  cleanup();
});

test("existing failed-save refresh reveals the conflict and preserves the original draft", async () => {
  const { cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  fireEvent.change(editor, { target: { value: "draft" } });
  rpc.workspace.write.mutate.mockRejectedValue(
    new Error("File changed on disk"),
  );
  rpc.workspace.read.query.mockResolvedValue(disk("external"));
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  await screen.findByRole("button", { name: "Merge with AI" });
  expect(rpc.workspace.write.mutate).toHaveBeenCalledWith({
    workspaceId: "wsp_test",
    path: "main.tea",
    text: "draft",
    expected: "original",
  });
  expect(editor).toHaveValue("draft");
  cleanup();
});

test.each(["accepted", "failed", "edited during admission"])(
  "AI merge %s preserves unsaved input until admission",
  async (outcome) => {
    const { client, transport, api, saves, cleanup } = setup();
    const editor = await screen.findByRole("textbox", { name: "Code" });
    fireEvent.change(editor, { target: { value: "draft" } });
    rpc.workspace.read.query.mockResolvedValue(disk("external"));
    await act(() =>
      client.invalidateQueries({
        queryKey: workspaceFileQueryOptions(transport, "wsp_test", "main.tea")
          .queryKey,
      }),
    );
    const button = await screen.findByRole("button", { name: "Merge with AI" });
    // Toolbar Save and prepare() use this same registered command.
    await expect(saves.get(api.id)!()).rejects.toThrow("external changes");
    expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
    let accept!: () => void;
    let reject!: (error: Error) => void;
    submitMerge.mockReturnValue(
      new Promise<void>((resolve, fail) => {
        accept = resolve;
        reject = fail;
      }),
    );
    fireEvent.click(button);
    await waitFor(() => expect(submitMerge).toHaveBeenCalledOnce());
    const [workspaceId, prompt] = submitMerge.mock.calls[0]!;
    expect(workspaceId).toBe("wsp_test");
    expect(JSON.parse(prompt.split("\n\n").at(-1)!)).toEqual({
      path: "main.tea",
      original: "original",
      local: "draft",
      disk: "external",
    });
    expect(editor).toHaveValue("draft");
    expect(button).toBeDisabled();
    if (outcome === "edited during admission")
      fireEvent.change(editor, { target: { value: "newer draft" } });
    await act(async () => {
      if (outcome === "failed") reject(new Error("Admission unavailable"));
      else accept();
    });
    if (outcome === "accepted") {
      await waitFor(() => expect(editor).toHaveValue("external"));
      expect(
        screen.queryByRole("button", { name: "Merge with AI" }),
      ).not.toBeInTheDocument();
    } else {
      await waitFor(() => expect(button).toBeEnabled());
      expect(editor).toHaveValue(
        outcome === "failed" ? "draft" : "newer draft",
      );
      if (outcome === "failed")
        await findErrorToast("Couldn’t start file merge");
    }
    expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
    cleanup();
  },
);

test("a committed save retains displayed text when disk refresh fails", async () => {
  const { api, cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  fireEvent.change(editor, { target: { value: "saved content" } });
  rpc.workspace.write.mutate.mockResolvedValue(disk("saved content").entry);
  rpc.workspace.read.query.mockRejectedValue(new Error("Refresh unavailable"));
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  await findErrorToast();
  await waitFor(() =>
    expect(api.updateParameters).toHaveBeenLastCalledWith({
      dirty: false,
      saving: false,
    }),
  );
  expect(editor).toHaveValue("saved content");
  cleanup();
});

test("editing during save stays dirty and the next save uses the committed hash", async () => {
  const { cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  let commit!: (entry: { path: string; hash: string }) => void;
  rpc.workspace.write.mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        commit = resolve;
      }),
  );
  fireEvent.change(editor, { target: { value: "first" } });
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  await waitFor(() =>
    expect(rpc.workspace.write.mutate).toHaveBeenCalledTimes(1),
  );
  fireEvent.change(editor, { target: { value: "second" } });
  rpc.workspace.read.query.mockResolvedValue(disk("first"));
  await act(async () => commit(disk("first").entry));
  expect(editor).toHaveValue("second");
  rpc.workspace.write.mutate.mockResolvedValue(disk("second").entry);
  rpc.workspace.read.query.mockResolvedValue(disk("second"));
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  await waitFor(() =>
    expect(rpc.workspace.write.mutate).toHaveBeenLastCalledWith({
      workspaceId: "wsp_test",
      path: "main.tea",
      text: "second",
      expected: "first",
    }),
  );
  cleanup();
});

test("built-in source opens read-only, cannot create a draft or save, and offers Duplicate to edit", async () => {
  const { api, user, cleanup } = setup({
    ...disk("original", "indicators/builtin/sma.tea"),
    readOnly: true,
  });
  const editor = await screen.findByRole("textbox", { name: "Code" });
  expect(editor).toHaveAttribute("readonly");
  fireEvent.change(editor, { target: { value: "attempted edit" } });
  fireEvent.keyDown(editor, { key: "s", metaKey: true });
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  expect(editor).toHaveValue("original");
  expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
  expect(api.updateParameters).toHaveBeenLastCalledWith({
    dirty: false,
    saving: false,
  });
  expect(await menuItems(user)).toContain("Duplicate to edit");
  cleanup();
});

const crumbs = async () =>
  within(await screen.findByRole("navigation", { name: "breadcrumb" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

test("word wrap updates the code view while preserving its draft and save state", async () => {
  const { api, cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  const wrap = screen.getByRole("button", { name: "Word wrap" });
  expect(wrap).toHaveAttribute("aria-pressed", "false");
  expect(editor).toHaveAttribute("wrap", "off");
  fireEvent.click(wrap);
  expect(wrap).toHaveAttribute("aria-pressed", "true");
  expect(editor).toHaveAttribute("wrap", "soft");
  expect(api.updateParameters).toHaveBeenLastCalledWith({
    dirty: false,
    saving: false,
  });
  fireEvent.change(editor, { target: { value: "unsaved draft" } });
  fireEvent.click(wrap);
  expect(screen.getByRole("textbox", { name: "Code" })).toBe(editor);
  expect(editor).toHaveValue("unsaved draft");
  expect(editor).toHaveAttribute("wrap", "off");
  expect(api.updateParameters).toHaveBeenLastCalledWith({
    dirty: true,
    saving: false,
  });
  expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
  cleanup();
});

test("Markdown offers no code-only wrap control", async () => {
  const { cleanup } = setup(disk("# Notes", "notes.md"));
  expect(await screen.findByRole("textbox", { name: "Code" })).toHaveValue(
    "# Notes",
  );
  expect(
    screen.queryByRole("button", { name: "Word wrap" }),
  ).not.toBeInTheDocument();
  cleanup();
});

test("the breadcrumb shows the workspace folder, then each path segment", async () => {
  const { cleanup } = setup(disk("original", "indicators/momentum/rsi.tea"));
  await waitFor(async () =>
    expect(await crumbs()).toEqual([
      "workspace",
      "indicators",
      "momentum",
      "rsi.tea",
    ]),
  );
  expect(screen.getByRole("link", { name: "rsi.tea" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  cleanup();
});

test("bytes without a viewer offer the default app", async () => {
  const { host, cleanup } = setup({
    entry: { path: "exports/archive.zip", hash: "zip-hash" },
    mediaType: "application/octet-stream",
    readOnly: false,
    base64: "UEsDBAA=",
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Open in default app" }),
  );
  expect(host.openPath).toHaveBeenCalledOnce();
  cleanup();
});

test("Office files render read-only and fall back to the default app when parsing fails", async () => {
  const { cleanup } = setup({
    entry: { path: "positions.xlsx", hash: "xlsx-hash" },
    mediaType: "application/octet-stream",
    readOnly: false,
    base64: Buffer.from("workbook").toString("base64"),
  });
  const viewer = await screen.findByRole("document", { name: "xlsx viewer" });
  expect(within(viewer).getByRole("status")).toHaveTextContent("workbook");
  await userEvent.click(within(viewer).getByRole("button", { name: "Fail" }));
  expect(
    await screen.findByRole("button", { name: "Open in default app" }),
  ).toBeInTheDocument();
  cleanup();
});

test("CSV opens as a table of the draft and edits as source", async () => {
  const { cleanup } = setup(disk("symbol,close\nAAPL,190", "prices.csv"));
  const table = await screen.findByRole("document", { name: "csv viewer" });
  expect(within(table).getByRole("status")).toHaveTextContent(
    "symbol,close AAPL,190",
  );
  await userEvent.click(screen.getByRole("tab", { name: "Source" }));
  expect(await screen.findByRole("textbox", { name: "Code" })).toHaveValue(
    "symbol,close\nAAPL,190",
  );
  expect(
    screen.queryByRole("button", { name: "Word wrap" }),
  ).not.toBeInTheDocument();
  cleanup();
});

test("Save shows only while the tab is dirty and writes the draft with its CAS hash", async () => {
  const { cleanup } = setup();
  const editor = await screen.findByRole("textbox", { name: "Code" });
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.change(editor, { target: { value: "draft" } });
  rpc.workspace.write.mutate.mockResolvedValue(disk("draft").entry);
  rpc.workspace.read.query.mockResolvedValue(disk("draft"));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument(),
  );
  expect(rpc.workspace.write.mutate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "wsp_test",
    path: "main.tea",
    text: "draft",
    expected: "original",
  });
  cleanup();
});

test("Copy path copies the Workspace-relative path", async () => {
  const { user, cleanup } = setup(disk("original", "indicators/rsi.tea"));
  const copy = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  await menuItems(user);
  await user.click(screen.getByRole("menuitem", { name: "Copy path" }));
  expect(copy).toHaveBeenCalledExactlyOnceWith("indicators/rsi.tea");
  cleanup();
});

test("Duplicate creates the copy under a free name without overwriting, then opens it", async () => {
  rpc.workspace.listDirectory.query.mockResolvedValue({
    status: "ready",
    entries: [
      { path: "indicators/rsi.tea" },
      { path: "indicators/rsi-copy.tea" },
    ],
    directories: ["indicators/rsi-copy-2.tea"],
  });
  rpc.workspace.write.mutate.mockResolvedValue({});
  const { user, containerApi, cleanup } = setup(
    disk("original", "indicators/rsi.tea"),
  );
  await screen.findByRole("textbox", { name: "Code" });
  await menuItems(user);
  await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  await waitFor(() => expect(containerApi.addPanel).toHaveBeenCalledOnce());
  expect(rpc.workspace.write.mutate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "wsp_test",
    path: "indicators/rsi-copy-3.tea",
    text: "original",
    expected: null,
  });
  expect(containerApi.addPanel).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "wsp_test/indicators/rsi-copy-3.tea",
      params: { workspaceId: "wsp_test", path: "indicators/rsi-copy-3.tea" },
    }),
  );
  cleanup();
});

test.each([
  [
    "notes.md",
    "text/plain",
    ["Copy path", "Duplicate", "Reveal in Finder", "Open in default app"],
  ],
  [
    "data.bin",
    "application/octet-stream",
    ["Copy path", "Reveal in Finder", "Open in default app"],
  ],
  [
    "chart.png",
    "image/png",
    ["Copy path", "Reveal in Finder", "Open in default app"],
  ],
])(
  "%s offers only the menu actions its type supports",
  async (path, mediaType, names) => {
    const { user, client, cleanup } = setup({
      ...disk("original", path),
      mediaType,
    });
    // Duplicate depends on the read's MIME, so assert once every read settles.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(await menuItems(user)).toEqual(names);
    cleanup();
  },
);

test("Finder and default-app actions use the file's absolute path", async () => {
  const { user, host, cleanup } = setup(disk("original", "indicators/rsi.tea"));
  await screen.findByRole("textbox", { name: "Code" });
  await menuItems(user);
  await user.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
  expect(host.revealPath).toHaveBeenCalledExactlyOnceWith(
    "/workspace/indicators/rsi.tea",
  );
  await menuItems(user);
  await user.click(
    screen.getByRole("menuitem", { name: "Open in default app" }),
  );
  expect(host.openPath).toHaveBeenCalledExactlyOnceWith(
    "/workspace/indicators/rsi.tea",
  );
  cleanup();
});

test("a file tab renders the app-provided action, whose prepare() saves the dirty draft first", async () => {
  const steps: string[] = [];
  const { cleanup } = setup(disk("original", "rsi.tea"), {
    extraActions: (file, prepare) => (
      <button
        type="button"
        onClick={async () => {
          await prepare();
          steps.push(`add ${file.workspaceId}/${file.path}`);
        }}
      >
        Add to chart
      </button>
    ),
  });
  const editor = await screen.findByRole("textbox", { name: "Code" });
  fireEvent.click(screen.getByRole("button", { name: "Add to chart" }));
  await waitFor(() => expect(steps).toEqual(["add wsp_test/rsi.tea"]));
  expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: "draft" } });
  rpc.workspace.write.mutate.mockImplementation(async () => {
    steps.push("save");
    return disk("draft", "rsi.tea").entry;
  });
  rpc.workspace.read.query.mockResolvedValue(disk("draft", "rsi.tea"));
  fireEvent.click(screen.getByRole("button", { name: "Add to chart" }));
  await waitFor(() =>
    expect(steps).toEqual([
      "add wsp_test/rsi.tea",
      "save",
      "add wsp_test/rsi.tea",
    ]),
  );
  expect(rpc.workspace.write.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ text: "draft", expected: "original" }),
  );
  cleanup();
});

test("a failed save rejects prepare(), so the app action stops and the save's toast is the only one", async () => {
  const steps: string[] = [];
  function AddAction({ prepare }: { prepare: () => Promise<void> }) {
    const add = useMutation({
      meta: { errorTitle: "Couldn’t add indicator" },
      mutationFn: async () => {
        await prepare();
        steps.push("add");
      },
      onError: () => steps.push("stopped"),
    });
    return (
      <button type="button" onClick={() => add.mutate()}>
        Add to chart
      </button>
    );
  }
  const { cleanup } = setup(disk("original", "rsi.tea"), {
    extraActions: (_file, prepare) => <AddAction prepare={prepare} />,
  });
  const editor = await screen.findByRole("textbox", { name: "Code" });
  fireEvent.change(editor, { target: { value: "draft" } });
  rpc.workspace.write.mutate.mockRejectedValue(new Error("conflict"));
  fireEvent.click(screen.getByRole("button", { name: "Add to chart" }));
  await waitFor(() => expect(steps).toEqual(["stopped"]));
  expect(
    toast
      .getToasts()
      .filter(
        (item) => "description" in item && item.description === "conflict",
      ),
  ).toHaveLength(1);
  expect(editor).toHaveValue("draft");
  cleanup();
});
