/// <reference types="vitest/jsdom" />
// Purpose: Verify the tree's identity, lazy listings, badges and row actions without a view around it.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  FileTree,
  type FileTreeActions,
} from "@openchart/app/features/workspace/components/file-tree";
import { WorkspaceContext } from "@openchart/app/features/workspace/components/context";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import { createTransport } from "@openchart/app/lib/transport/transport";
import { testAppHost } from "@openchart/app/testing/test-utils";

const rpc = vi.hoisted(() => ({
  workspace: { listDirectory: { query: vi.fn() }, read: { query: vi.fn() } },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));

function setup(
  paths: string[],
  directories: string[],
  actions: Partial<FileTreeActions> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createTransport({ origin: "http://localhost:41000" });
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
  render(
    <QueryClientProvider client={client}>
      <WorkspaceContext.Provider
        value={{
          transport,
          saves: { current: new Map() },
          instanceId: "test",
          collapsible: false,
          dark: false,
        }}
      >
        <AppHostProvider value={testAppHost()}>
          <FileTree
            workspace={{ id: "wsp_test", root: "/workspaces/default" }}
            dirty={new Set()}
            search=""
            onFocus={vi.fn()}
            onOpen={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onMove={vi.fn()}
            canMove={() => true}
            {...actions}
          />
        </AppHostProvider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}
const row = (name: string) => screen.findByRole("treeitem", { name });
const menuItems = async () =>
  (await screen.findAllByRole("menuitem")).map((item) => item.textContent);

// Context Menu attaches DOM listeners with a signal from the browser realm.
beforeEach(() =>
  vi.stubGlobal("AbortController", jsdom.window.AbortController),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("sorts folders first, keeps duplicate basenames distinct and opens exact paths", async () => {
  const open = vi.fn();
  const { user } = setup(
    ["z.pdf", "Makefile", "one/same.tea", "two/same.tea"],
    ["empty", "empty/nested", "one", "two"],
    { onOpen: open },
  );
  await row("z.pdf");
  expect(
    screen
      .getAllByRole("treeitem")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual(["empty", "one", "two", "z.pdf", "Makefile"]);
  expect(await row("z.pdf")).toHaveAttribute("title", "z.pdf");
  expect(within(await row("z.pdf")).getByText("pdf")).toBeVisible();
  // A name without an extension keeps a plain icon instead of a badge.
  expect(await row("Makefile")).toHaveTextContent(/^Makefile$/);
  await user.click(await row("one"));
  await user.click(await row("two"));
  const copies = await screen.findAllByRole("treeitem", { name: "same.tea" });
  expect(copies.map((item) => item.getAttribute("title"))).toEqual([
    "one/same.tea",
    "two/same.tea",
  ]);
  expect(copies.map((item) => item.getAttribute("aria-level"))).toEqual([
    "2",
    "2",
  ]);
  await user.click(copies[1]!);
  expect(open).toHaveBeenCalledExactlyOnceWith("two/same.tea");
});

test("lists a folder only once it is expanded", async () => {
  const { user } = setup(["empty/nested/deep.md"], ["empty", "empty/nested"]);
  const folder = await row("empty");
  expect(folder).toHaveAttribute("aria-expanded", "false");
  expect(rpc.workspace.listDirectory.query).toHaveBeenCalledExactlyOnceWith(
    { workspaceId: "wsp_test", path: "" },
    expect.anything(),
  );
  await user.click(folder);
  expect(await row("nested")).toHaveAttribute("title", "empty/nested");
  expect(rpc.workspace.listDirectory.query).toHaveBeenLastCalledWith(
    { workspaceId: "wsp_test", path: "empty" },
    expect.anything(),
  );
  expect(folder).toHaveAttribute("aria-expanded", "true");
});

test("a folder that disappears while expanded closes instead of staying listed", async () => {
  const { user } = setup([], ["src"]);
  rpc.workspace.listDirectory.query.mockImplementation(
    async ({ path }: { path: string }) =>
      path === "src"
        ? { status: "missing" }
        : { status: "ready", entries: [], directories: ["src"] },
  );
  const folder = await row("src");
  await user.click(folder);
  await waitFor(() =>
    expect(rpc.workspace.listDirectory.query).toHaveBeenLastCalledWith(
      { workspaceId: "wsp_test", path: "src" },
      expect.anything(),
    ),
  );
  await waitFor(() => expect(folder).toHaveAttribute("aria-expanded", "false"));
});

test("folder rows add files without toggling, and menus target their own row", async () => {
  const create = vi.fn();
  const open = vi.fn();
  const { user } = setup(["src/main.tea"], ["src"], {
    onCreate: create,
    onOpen: open,
  });
  const folder = await row("src");
  await user.click(screen.getByRole("button", { name: "New file in src" }));
  expect(create).toHaveBeenCalledExactlyOnceWith("file", "src");
  expect(folder).toHaveAttribute("aria-expanded", "false");
  fireEvent.contextMenu(folder);
  expect(await menuItems()).toEqual([
    "New file",
    "New folder",
    "Rename",
    "Copy path",
    "Reveal in Finder",
    "Delete",
  ]);
  await user.click(screen.getByRole("menuitem", { name: "New folder" }));
  expect(create).toHaveBeenLastCalledWith("folder", "src");
  await user.click(folder);
  const file = await row("main.tea");
  fireEvent.contextMenu(file);
  expect(await menuItems()).toEqual([
    "Rename",
    "Copy path",
    "Reveal in Finder",
    "Delete",
  ]);
  expect(open).not.toHaveBeenCalled();
});

test("Quick Look previews a file beside its row, opens it, and toggles with Space", async () => {
  const open = vi.fn();
  const { user } = setup(["notes.md"], [], { onOpen: open });
  rpc.workspace.read.query.mockResolvedValue({
    entry: { path: "notes.md", hash: "h" },
    mediaType: "text/plain",
    readOnly: false,
    base64: btoa("# Notes\nline two"),
  });
  await row("notes.md");
  await user.click(screen.getByRole("button", { name: "Quick Look notes.md" }));
  const card = await screen.findByRole("dialog", {
    name: "Quick Look notes.md",
  });
  expect(await within(card).findByText(/line two/)).toBeVisible();
  expect(card).toHaveTextContent("MD · 16 B");
  await user.click(within(card).getByRole("button", { name: "Open" }));
  expect(open).toHaveBeenCalledExactlyOnceWith("notes.md");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  const file = await row("notes.md");
  act(() => file.focus());
  // user-event's default key map sends no code for Space; Headless Tree reads it.
  const space = () => {
    fireEvent.keyDown(file, { key: " ", code: "Space" });
    fireEvent.keyUp(file, { key: " ", code: "Space" });
  };
  space();
  expect(
    await screen.findByRole("dialog", { name: "Quick Look notes.md" }),
  ).toBeVisible();
  space();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
