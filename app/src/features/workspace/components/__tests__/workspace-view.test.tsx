import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
import { findErrorToast, testAppHost } from "@openchart/app/testing/test-utils";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
/// <reference types="vitest/jsdom" />
// Purpose: Verify the Workspace navigator, file actions and local draft protection across route/window exits.
import { createRef, useEffect } from "react";
import {
  AuiConfig,
  AuiProvider,
  ModelContextClient,
  type AssistantClient,
} from "@assistant-ui/react";
import { createMemoryRouter, Link, Outlet, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DockviewReadyEvent } from "dockview-react";
import { createTransport } from "@openchart/app/lib/transport/transport";
import { UnsavedChangesProvider } from "@openchart/app/lib/unsaved-changes/unsaved-changes";
import { AppHostProvider, type AppHost } from "@openchart/app/lib/host/host";
import { workspacesQueryOptions } from "@openchart/app/lib/workspace/workspace";
import { useSidebar } from "@openchart/app/components/ui/sidebar";
import { WorkspaceView } from "@openchart/app/features/workspace/components/workspace-view";

const rpc = vi.hoisted(() => ({
  resources: {
    workspace: {
      list: { query: vi.fn() },
      getDefault: { query: vi.fn() },
      forget: { mutate: vi.fn() },
    },
  },
  workspace: {
    listDirectory: { query: vi.fn() },
    listTree: { query: vi.fn() },
    write: { mutate: vi.fn() },
    mkdir: { mutate: vi.fn() },
    read: { query: vi.fn() },
    remove: { mutate: vi.fn() },
    rename: { mutate: vi.fn() },
    removeDirectory: { mutate: vi.fn() },
  },
}));
type Panel = {
  id: string;
  params: {
    workspaceId: string;
    path: string;
    dirty?: boolean;
    saving?: boolean;
  };
  api: {
    close: () => void;
    setActive: () => void;
    updateParameters: (next: { moving: boolean }) => void;
  };
};
const api = vi.hoisted(() => ({
  panels: [] as Panel[],
  getPanel: vi.fn(),
  addPanel: vi.fn(),
  activePanel: undefined as
    | { params: { workspaceId: string; path: string; dirty?: boolean } }
    | undefined,
  listeners: new Set<() => void>(),
  onDidLayoutChange: (listener: () => void) => {
    api.listeners.add(listener);
    return { dispose: () => api.listeners.delete(listener) };
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
vi.mock("dockview-react", async (original) => ({
  ...(await original<typeof import("dockview-react")>()),
  DockviewReact: ({
    onReady,
  }: {
    onReady: (event: DockviewReadyEvent) => void;
  }) => {
    useEffect(
      () => onReady({ api } as unknown as DockviewReadyEvent),
      [onReady],
    );
    return <div />;
  },
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
function PanelState() {
  return <span data-testid="panel-state">{useSidebar().state}</span>;
}
// Only the DOM event needs jsdom's signal; router navigation must retain Node's.
function openContextMenu(element: HTMLElement) {
  const nativeAbortController = globalThis.AbortController;
  vi.stubGlobal("AbortController", jsdom.window.AbortController);
  try {
    fireEvent.contextMenu(element);
  } finally {
    vi.stubGlobal("AbortController", nativeAbortController);
  }
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  api.panels.length = 0;
  api.activePanel = undefined;
  api.listeners.clear();
  localStorage.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const defaultWorkspace = { id: "wsp_test", root: "/workspaces/default" };
const researchWorkspace = { id: "wsp_research", root: "/workspaces/research" };
const row = (name: string) => screen.findByRole("treeitem", { name });
function setup(
  directories: string[] = [],
  workspaces = [defaultWorkspace],
  paths: string[] = [],
  collapsible = false,
  file?: { workspaceId: string; path: string },
  host: Partial<AppHost> = {},
) {
  rpc.resources.workspace.getDefault.query.mockResolvedValue(
    defaultWorkspace.id,
  );
  rpc.resources.workspace.list.query.mockResolvedValue({
    items: workspaces,
    nextCursor: null,
  });
  rpc.workspace.listDirectory.query.mockImplementation(
    async ({ path: directory }: { path: string }) => ({
      status: "ready",
      entries: paths
        .filter((path) => path.split("/").slice(0, -1).join("/") === directory)
        .map((path) => ({ path })),
      directories: directories.filter(
        (path) => path.split("/").slice(0, -1).join("/") === directory,
      ),
    }),
  );
  rpc.workspace.listTree.query.mockResolvedValue({
    status: "ready",
    entries: paths.map((path) => ({ path })),
    directories,
  });
  rpc.workspace.read.query.mockImplementation(
    async ({ path }: { path: string }) => ({
      entry: { path, hash: "a".repeat(64) },
      mediaType: "text/plain",
      base64: btoa("content"),
      readOnly: false,
    }),
  );
  const client = createQueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createTransport({ origin: "http://127.0.0.1:41000" });
  const router = createMemoryRouter([
    {
      element: (
        <>
          <Link to="/next">Leave workspace</Link>
          <UnsavedChangesProvider>
            <Outlet />
          </UnsavedChangesProvider>
        </>
      ),
      children: [
        {
          path: "/",
          element: (
            <WorkspaceView
              transport={transport}
              title={collapsible ? undefined : "Workspace"}
              file={file}
              collapsible={collapsible}
              navigation={<PanelState />}
            />
          ),
        },
        { path: "/next", element: <p>Next page</p> },
      ],
    },
  ]);
  const aui = createRef<AssistantClient>();
  const context = AuiConfig({ modelContext: ModelContextClient() });
  const appHost = testAppHost({ revealPath: vi.fn(async () => {}), ...host });
  const view = render(
    <QueryClientProvider client={client}>
      <AppHostProvider value={appHost}>
        <AuiProvider config={context} ref={aui}>
          <RouterProvider router={router} />
        </AuiProvider>
      </AppHostProvider>
    </QueryClientProvider>,
  );
  cleanups.push(
    () => client.clear(),
    () => router.dispose(),
    view.unmount,
  );
  return {
    user: userEvent.setup(),
    router,
    client,
    transport,
    appHost,
    unmount: view.unmount,
    readContext: () => aui.current!.modelContext.getModelContext().system,
  };
}
/** An open tab, announced like Dockview's layout event so the tree sees its dirty flag. */
function openPanel(workspaceId: string, path: string, dirty = true) {
  const panel: Panel = {
    id: `${workspaceId}/${path}`,
    params: { workspaceId, path, dirty },
    api: {
      close: vi.fn(() => {
        api.panels.splice(api.panels.indexOf(panel), 1);
      }),
      setActive: vi.fn(),
      updateParameters: vi.fn(),
    },
  };
  api.panels.push(panel);
  act(() => api.listeners.forEach((listener) => listener()));
  return panel;
}
async function chooseWorkspace(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(
    await screen.findByRole("button", { name: /^Browse workspace:/ }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name }));
}

test("publishes only the active file and clears its context on close and route exit", async () => {
  const { readContext, router } = setup();
  expect(readContext()).toBe(JSON.stringify({ view: "workspace", file: null }));
  for (const workspaceId of ["wsp_test", "wsp_research"]) {
    act(() => {
      api.activePanel = {
        params: { workspaceId, path: "main.tea", dirty: true },
      };
      api.listeners.forEach((listener) => listener());
    });
    expect(readContext()).toBe(
      JSON.stringify({
        view: "workspace",
        file: { workspaceId, path: "main.tea" },
      }),
    );
  }
  act(() => {
    api.activePanel = undefined;
    api.listeners.forEach((listener) => listener());
  });
  expect(readContext()).toBe(JSON.stringify({ view: "workspace", file: null }));
  await act(() => router.navigate("/next"));
  expect(readContext()).toBeUndefined();
  expect(api.listeners.size).toBe(0);
});

test("shows one workspace at a time and remembers the choice for the next visit", async () => {
  const { user, unmount } = setup(
    [],
    [defaultWorkspace, researchWorkspace],
    ["main.tea"],
  );
  expect(
    await screen.findByRole("button", { name: "Browse workspace: default" }),
  ).toBeVisible();
  expect(await row("main.tea")).toBeVisible();
  expect(rpc.workspace.listDirectory.query).toHaveBeenLastCalledWith(
    { workspaceId: "wsp_test", path: "" },
    expect.anything(),
  );
  await chooseWorkspace(user, "research");
  expect(
    await screen.findByRole("button", { name: "Browse workspace: research" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(rpc.workspace.listDirectory.query).toHaveBeenLastCalledWith(
      { workspaceId: "wsp_research", path: "" },
      expect.anything(),
    ),
  );
  expect(screen.getByRole("textbox", { name: "Search files" })).toHaveAttribute(
    "placeholder",
    "Search research",
  );
  unmount();
  setup([], [defaultWorkspace, researchWorkspace], ["main.tea"]);
  expect(
    await screen.findByRole("button", { name: "Browse workspace: research" }),
  ).toBeVisible();
});

test("searches the selected workspace's unopened folders and opens a match with the keyboard", async () => {
  const { user } = setup(
    ["indicators"],
    [defaultWorkspace, researchWorkspace],
    ["indicators/semis.tea", "unrelated.md"],
  );
  await row("indicators");
  expect(rpc.workspace.listTree.query).not.toHaveBeenCalled();
  const search = screen.getByRole("textbox", { name: "Search files" });
  await user.type(search, "semis");
  const match = await row("semis.tea");
  expect(await row("indicators")).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.queryByRole("treeitem", { name: "unrelated.md" }),
  ).not.toBeInTheDocument();
  expect(rpc.workspace.listTree.query).toHaveBeenCalledExactlyOnceWith(
    { workspaceId: "wsp_test" },
    expect.anything(),
  );
  expect(rpc.workspace.read.query).not.toHaveBeenCalled();
  act(() => match.focus());
  await user.keyboard("{Enter}");
  expect(api.addPanel).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { workspaceId: "wsp_test", path: "indicators/semis.tea" },
    }),
  );
  await user.clear(search);
  await user.type(search, "no-such-file");
  expect(await screen.findByText("No matching files.")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(search).toHaveValue("");
  expect(await row("unrelated.md")).toBeVisible();
  expect(
    screen.queryByRole("treeitem", { name: "semis.tea" }),
  ).not.toBeInTheDocument();
});

test("a failed search listing offers a retry instead of reporting no matches", async () => {
  const { user } = setup();
  rpc.workspace.listTree.query.mockResolvedValue({ status: "missing" });
  await screen.findByRole("button", { name: "Browse workspace: default" });
  await user.type(
    screen.getByRole("textbox", { name: "Search files" }),
    "semis",
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(screen.queryByText("No matching files.")).not.toBeInTheDocument();
  rpc.workspace.listTree.query.mockResolvedValue({
    status: "ready",
    entries: [{ path: "semis.tea" }],
    directories: [],
  });
  await user.click(retry);
  expect(await row("semis.tea")).toBeVisible();
});

test("opens a requested file after Dockview is ready, shows its workspace and publishes its identity", async () => {
  const file = { workspaceId: "wsp_research", path: "indicators/My study.tea" };
  api.addPanel.mockImplementation(({ params }) => {
    api.activePanel = { params };
    api.listeners.forEach((listener) => listener());
  });
  const { readContext } = setup(
    [],
    [defaultWorkspace, researchWorkspace],
    [],
    false,
    file,
  );
  await waitFor(() =>
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "wsp_research/indicators/My study.tea",
        params: file,
      }),
    ),
  );
  expect(readContext()).toBe(JSON.stringify({ view: "workspace", file }));
  expect(
    await screen.findByRole("button", { name: "Browse workspace: research" }),
  ).toBeVisible();
});

test.each([
  { collapsible: false, rail: "Resize files", state: "expanded" },
  { collapsible: true, rail: "Toggle Sidebar", state: "collapsed" },
])(
  "Cmd+B leaves the file panel $state when collapsible is $collapsible",
  async ({ collapsible, rail, state }) => {
    const { user } = setup([], [defaultWorkspace], [], collapsible);
    expect(screen.getByTestId("panel-state")).toHaveTextContent("expanded");
    screen.getByRole("button", { name: rail }).focus();
    await user.keyboard("{Meta>}b{/Meta}");
    expect(screen.getByTestId("panel-state")).toHaveTextContent(state);
  },
);

test("Add creates a folder at the root and refreshes it from disk", async () => {
  const { user } = setup();
  await screen.findByRole("button", { name: "Browse workspace: default" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Create folder" });
  const input = within(dialog).getByRole("textbox", { name: "Folder path" });
  expect(input).toHaveValue("untitled");
  await user.clear(input);
  await user.type(input, "empty");
  rpc.workspace.mkdir.mutate.mockImplementation(async () => {
    rpc.workspace.listDirectory.query.mockResolvedValue({
      status: "ready",
      entries: [],
      directories: ["empty"],
    });
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Create folder" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(rpc.workspace.mkdir.mutate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "wsp_test",
    path: "empty",
  });
  expect(await row("empty")).toHaveAttribute("aria-expanded", "false");
  expect(rpc.workspace.write.mutate).not.toHaveBeenCalled();
});

test("a folder's New file creates inside it and opens the new tab", async () => {
  const { user } = setup(["src"]);
  openContextMenu(await row("src"));
  await user.click(await screen.findByRole("menuitem", { name: "New file" }));
  const dialog = await screen.findByRole("dialog", { name: "Create file" });
  expect(
    within(dialog).getByRole("textbox", { name: "File path" }),
  ).toHaveValue("src/untitled.workflow.ts");
  rpc.workspace.write.mutate.mockResolvedValue({
    path: "src/untitled.workflow.ts",
    hash: "a".repeat(64),
  });
  await user.click(within(dialog).getByRole("button", { name: "Create file" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(rpc.workspace.write.mutate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "wsp_test",
    path: "src/untitled.workflow.ts",
    text: expect.stringContaining("export default defineWorkflow({"),
    expected: null,
  });
  expect(api.addPanel).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "wsp_test/src/untitled.workflow.ts",
      params: { workspaceId: "wsp_test", path: "src/untitled.workflow.ts" },
    }),
  );
});

test("Add targets the focused folder, or the focused file's folder", async () => {
  const { user } = setup(["src"], [defaultWorkspace], ["src/main.tea"]);
  await user.click(await row("src"));
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(await screen.findByRole("menuitem", { name: "New file" }));
  let dialog = await screen.findByRole("dialog", { name: "Create file" });
  expect(
    within(dialog).getByRole("textbox", { name: "File path" }),
  ).toHaveValue("src/untitled.workflow.ts");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(await row("main.tea"));
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
  dialog = await screen.findByRole("dialog", { name: "Create folder" });
  expect(
    within(dialog).getByRole("textbox", { name: "Folder path" }),
  ).toHaveValue("src/untitled");
});

test("opens identical relative paths from different workspaces in separate tabs", async () => {
  const { user } = setup(
    [],
    [defaultWorkspace, researchWorkspace],
    ["main.tea"],
  );
  const panels = new Map<
    string,
    { api: { setActive: ReturnType<typeof vi.fn> } }
  >();
  api.getPanel.mockImplementation((id: string) => panels.get(id));
  api.addPanel.mockImplementation(({ id }: { id: string }) => {
    panels.set(id, { api: { setActive: vi.fn() } });
  });
  await user.click(await row("main.tea"));
  await chooseWorkspace(user, "research");
  await waitFor(() =>
    expect(rpc.workspace.listDirectory.query).toHaveBeenLastCalledWith(
      { workspaceId: "wsp_research", path: "" },
      expect.anything(),
    ),
  );
  await user.click(await row("main.tea"));
  expect(api.addPanel).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      id: "wsp_test/main.tea",
      params: { workspaceId: "wsp_test", path: "main.tea" },
    }),
  );
  expect(api.addPanel).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      id: "wsp_research/main.tea",
      params: { workspaceId: "wsp_research", path: "main.tea" },
    }),
  );
  await chooseWorkspace(user, "default");
  await user.click(await row("main.tea"));
  expect(api.addPanel).toHaveBeenCalledTimes(2);
  expect(panels.get("wsp_test/main.tea")?.api.setActive).toHaveBeenCalledOnce();
});

test("newly registered workspaces join the switcher without changing the view or losing dirty tabs", async () => {
  const { user, client, transport, router } = setup(
    [],
    [defaultWorkspace],
    ["main.tea"],
  );
  await user.click(await row("main.tea"));
  const dirtyPanel = openPanel(defaultWorkspace.id, "main.tea");
  rpc.resources.workspace.list.query.mockResolvedValue({
    items: [defaultWorkspace, researchWorkspace],
    nextCursor: null,
  });
  await act(() => client.invalidateQueries(workspacesQueryOptions(transport)));
  await user.click(
    screen.getByRole("button", { name: "Browse workspace: default" }),
  );
  expect(
    await screen.findByRole("menuitemradio", { name: "research" }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("button", { name: "Browse workspace: default" }),
  ).toBeVisible();
  expect(router.state.location.pathname).toBe("/");
  expect(api.panels).toContain(dirtyPanel);
  expect(api.addPanel).toHaveBeenCalledOnce();
});

test("failed creation keeps its draft until closing, then reopening starts a fresh form", async () => {
  const { user } = setup(["src"]);
  openContextMenu(await row("src"));
  await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Create folder" });
  const input = within(dialog).getByRole("textbox", { name: "Folder path" });
  await user.clear(input);
  await user.type(input, "src/custom");
  rpc.workspace.mkdir.mutate.mockRejectedValue(
    new Error("Couldn’t create this folder."),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Create folder" }),
  );
  expect(
    await findErrorToast("Couldn’t create this folder."),
  ).toHaveTextContent("Couldn’t create this folder.");
  expect(
    within(dialog).getByRole("textbox", { name: "Folder path" }),
  ).toHaveValue("src/custom");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  openContextMenu(await row("src"));
  await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
  const reopened = await screen.findByRole("dialog", { name: "Create folder" });
  expect(
    within(reopened).getByRole("textbox", { name: "Folder path" }),
  ).toHaveValue("src/untitled");
  await user.click(within(reopened).getByRole("button", { name: "Cancel" }));
  expect(rpc.workspace.mkdir.mutate).toHaveBeenCalledTimes(1);
});

test("deleting confirms the exact file, retains dirty tabs on failure, and closes only its tab after success", async () => {
  const { user } = setup(["src"], [defaultWorkspace], ["src/main.tea"]);
  const target = openPanel(defaultWorkspace.id, "src/main.tea");
  const sibling = openPanel(defaultWorkspace.id, "other.tea");
  const otherWorkspace = openPanel(researchWorkspace.id, "src/main.tea");
  await user.click(await row("src"));
  expect(rpc.workspace.read.query).not.toHaveBeenCalled();
  openContextMenu(await row("main.tea"));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  let dialog = await screen.findByRole("dialog", { name: "Delete file?" });
  expect(dialog).toHaveTextContent("src/main.tea");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(target.api.close).not.toHaveBeenCalled();

  openContextMenu(await row("main.tea"));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  dialog = await screen.findByRole("dialog", { name: "Delete file?" });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Delete file" }),
    ).toBeEnabled(),
  );
  rpc.workspace.remove.mutate.mockRejectedValueOnce(
    new Error("File changed on disk"),
  );
  await user.click(within(dialog).getByRole("button", { name: "Delete file" }));
  await findErrorToast("Couldn’t delete file");
  expect(dialog).toBeInTheDocument();
  expect(target.api.close).not.toHaveBeenCalled();
  expect(rpc.workspace.remove.mutate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: defaultWorkspace.id,
    path: "src/main.tea",
    expected: "a".repeat(64),
  });
  rpc.workspace.remove.mutate.mockResolvedValueOnce(undefined);
  rpc.workspace.listDirectory.query.mockResolvedValue({
    status: "ready",
    entries: [],
    directories: [],
  });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Delete file" }),
    ).toBeEnabled(),
  );
  await user.click(within(dialog).getByRole("button", { name: "Delete file" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(target.api.close).toHaveBeenCalledOnce();
  expect(sibling.api.close).not.toHaveBeenCalled();
  expect(otherWorkspace.api.close).not.toHaveBeenCalled();
  expect(api.addPanel).not.toHaveBeenCalled();
});

test("read-only files cannot be deleted", async () => {
  const { user } = setup([], [defaultWorkspace], ["builtin.tea"]);
  rpc.workspace.read.query.mockResolvedValue({
    entry: { path: "builtin.tea", hash: "a".repeat(64) },
    mediaType: "text/plain",
    base64: btoa("builtin"),
    readOnly: true,
  });
  openContextMenu(await row("builtin.tea"));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete file?" });
  expect(
    await within(dialog).findByText("Built-in files are read-only."),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Delete file" }),
  ).toBeDisabled();
  expect(rpc.workspace.remove.mutate).not.toHaveBeenCalled();
});

test("deleting a folder confirms it and closes only tabs inside it", async () => {
  const { user } = setup(["src", "srcfiles"]);
  const inside = openPanel(defaultWorkspace.id, "src/deep/main.tea", false);
  const prefixed = openPanel(defaultWorkspace.id, "srcfiles/main.tea", false);
  openContextMenu(await row("src"));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete folder?" });
  expect(dialog).toHaveTextContent("src and everything in it");
  rpc.workspace.removeDirectory.mutate.mockResolvedValue(undefined);
  await user.click(
    within(dialog).getByRole("button", { name: "Delete folder" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(rpc.workspace.removeDirectory.mutate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: defaultWorkspace.id,
    path: "src",
  });
  expect(inside.api.close).toHaveBeenCalledOnce();
  expect(prefixed.api.close).not.toHaveBeenCalled();
});

test("renaming moves a file and its clean tab follows; dirty tabs block it", async () => {
  const { user } = setup(["src"], [defaultWorkspace], ["src/main.tea"]);
  await user.click(await row("src"));
  const clean = openPanel(defaultWorkspace.id, "src/main.tea", false);
  const file = await row("main.tea");
  act(() => file.focus());
  // user-event's default key map has no function keys; send F2's real code.
  fireEvent.keyDown(file, { key: "F2", code: "F2" });
  fireEvent.keyUp(file, { key: "F2", code: "F2" });
  const input = await screen.findByRole("textbox", { name: "Rename main.tea" });
  await user.clear(input);
  await user.type(input, "renamed.tea{Enter}");
  await waitFor(() =>
    expect(rpc.workspace.rename.mutate).toHaveBeenCalledExactlyOnceWith({
      workspaceId: defaultWorkspace.id,
      from: "src/main.tea",
      to: "src/renamed.tea",
    }),
  );
  await waitFor(() => expect(clean.api.close).toHaveBeenCalledOnce());
  expect(api.addPanel).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { workspaceId: defaultWorkspace.id, path: "src/renamed.tea" },
    }),
  );

  openPanel(defaultWorkspace.id, "src/main.tea");
  // The open menu hides the rest of the page from assistive queries.
  expect(
    await screen.findByRole("img", { name: "Unsaved changes" }),
  ).toBeVisible();
  openContextMenu(await row("src"));
  expect(
    await screen.findByRole("menuitem", { name: "Rename" }),
  ).toHaveAttribute("aria-disabled", "true");
});

test("tabs under a moving folder are read-only until it moves, then reopen at the new path", async () => {
  const { user } = setup(["src"]);
  const inside = openPanel(defaultWorkspace.id, "src/main.tea", false);
  const outside = openPanel(defaultWorkspace.id, "other.tea", false);
  let finish!: () => void;
  rpc.workspace.rename.mutate.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const folder = await row("src");
  act(() => folder.focus());
  fireEvent.keyDown(folder, { key: "F2", code: "F2" });
  fireEvent.keyUp(folder, { key: "F2", code: "F2" });
  const input = await screen.findByRole("textbox", { name: "Rename src" });
  await user.clear(input);
  await user.type(input, "lib{Enter}");
  await waitFor(() => expect(rpc.workspace.rename.mutate).toHaveBeenCalled());
  expect(inside.api.updateParameters).toHaveBeenCalledExactlyOnceWith({
    moving: true,
  });
  expect(inside.api.close).not.toHaveBeenCalled();
  expect(outside.api.updateParameters).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(inside.api.close).toHaveBeenCalledOnce());
  expect(api.addPanel).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      params: { workspaceId: defaultWorkspace.id, path: "lib/main.tea" },
    }),
  );
  expect(outside.api.close).not.toHaveBeenCalled();
});

test("the switcher reveals the workspace folder in Finder", async () => {
  const { user, appHost } = setup();
  await user.click(
    await screen.findByRole("button", { name: "Browse workspace: default" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Reveal in Finder" }),
  );
  expect(appHost.revealPath).toHaveBeenCalledExactlyOnceWith(
    "/workspaces/default",
  );
});

test("forget is offered only for non-default workspaces and closes only that workspace's tabs", async () => {
  const { user } = setup([], [defaultWorkspace, researchWorkspace]);
  const first = openPanel(researchWorkspace.id, "main.tea");
  const second = openPanel(researchWorkspace.id, "other.tea");
  const kept = openPanel(defaultWorkspace.id, "main.tea");
  await user.click(
    await screen.findByRole("button", { name: "Browse workspace: default" }),
  );
  await screen.findByRole("menuitem", { name: "Reveal in Finder" });
  expect(
    screen.queryByRole("menuitem", { name: "Forget workspace" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitemradio", { name: "research" }));
  rpc.workspace.listDirectory.query.mockResolvedValue({ status: "missing" });
  await user.click(
    await screen.findByRole("button", { name: "Browse workspace: research" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Forget workspace" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Forget workspace?",
  });
  expect(dialog).toHaveTextContent("/workspaces/research");
  expect(dialog).toHaveTextContent("Files on disk will be kept.");
  rpc.resources.workspace.forget.mutate.mockRejectedValueOnce(
    new Error("Forget failed"),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Forget workspace" }),
  );
  await findErrorToast("Couldn’t forget workspace");
  expect(first.api.close).not.toHaveBeenCalled();
  rpc.resources.workspace.forget.mutate.mockImplementationOnce(async () => {
    rpc.resources.workspace.list.query.mockResolvedValue({
      items: [defaultWorkspace],
      nextCursor: null,
    });
  });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Forget workspace" }),
    ).toBeEnabled(),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Forget workspace" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("button", { name: "Browse workspace: default" }),
  ).toBeVisible();
  expect(rpc.resources.workspace.forget.mutate).toHaveBeenLastCalledWith({
    id: researchWorkspace.id,
  });
  expect(first.api.close).toHaveBeenCalledOnce();
  expect(second.api.close).toHaveBeenCalledOnce();
  expect(kept.api.close).not.toHaveBeenCalled();
  expect(rpc.workspace.remove.mutate).not.toHaveBeenCalled();
});

test.each(["dirty", "saving"] as const)(
  "protects %s tabs from outer navigation and window exits, then cleans up on unmount",
  async (flag) => {
    const { user, router } = setup();
    await screen.findByRole("button", { name: "Browse workspace: default" });
    const panel = openPanel(defaultWorkspace.id, "main.tea", false);
    panel.params[flag] = true;

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("link", { name: "Leave workspace" }));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(router.state.location.pathname).toBe("/");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");

    await user.click(screen.getByRole("link", { name: "Leave workspace" }));
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(await screen.findByText("Next page")).toBeVisible();
    expect(router.state.location.pathname).toBe("/next");

    const afterUnmount = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  },
);

test("reads current tab flags so completed saves allow navigation and window exits", async () => {
  const { user, router } = setup();
  await screen.findByRole("button", { name: "Browse workspace: default" });
  const panel = openPanel(defaultWorkspace.id, "main.tea");
  panel.params.saving = true;
  const beforeSave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeSave);
  expect(beforeSave.defaultPrevented).toBe(true);

  panel.params.dirty = false;
  panel.params.saving = false;
  const afterSave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(afterSave);
  expect(afterSave.defaultPrevented).toBe(false);
  await user.click(screen.getByRole("link", { name: "Leave workspace" }));
  expect(await screen.findByText("Next page")).toBeVisible();
  expect(router.state.location.pathname).toBe("/next");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
