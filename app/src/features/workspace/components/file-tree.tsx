// Purpose: Render one Workspace as a keyboard, rename and drag capable tree with per-row actions.
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  renamingFeature,
  syncDataLoaderFeature,
  type DragTarget,
  type ItemInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  Ellipsis,
  Eye,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@openchart/app/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@openchart/app/components/ui/popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@openchart/app/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { useErrorToast } from "@openchart/app/hooks/use-error-toast";
import {
  workspaceDirectoryQueryOptions,
  workspaceName,
  workspaceTreeQueryOptions,
} from "@openchart/app/lib/workspace/workspace";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { cn } from "@openchart/app/utils/cn";
import { useWorkspaceShell } from "../hooks/use-workspace-shell";
import { useWorkspaceView } from "./context";
import { QuickLook } from "./file-panel/quick-look";

export type CreateKind = "file" | "folder";
/** One row's workspace-relative identity; folders also move and delete whole. */
export type TreeEntry = { path: string; folder: boolean };

type Node = TreeEntry & { id: string; name: string };
type Listing = {
  directories: readonly string[];
  entries: readonly { path: string }[];
};

const ROOT = ":root";
type DirectoryQuery = UseQueryResult<
  Awaited<
    ReturnType<AppTransport["rpc"]["workspace"]["listDirectory"]["query"]>
  >
>;
// Module-level so Query memoizes the combined listings between renders.
const pickListings = (results: DirectoryQuery[]) =>
  results.map(({ data, isPending, isError, refetch }) => ({
    data,
    isPending,
    isError,
    refetch,
  }));
const INDENT = 12;
const basename = (path: string) => path.split("/").at(-1) ?? path;
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const join = (directory: string, name: string) =>
  directory ? `${directory}/${name}` : name;
const node = (path: string, folder: boolean): Node => ({
  id: path || ROOT,
  path,
  name: basename(path),
  folder,
});

/** Nodes and ordered child ids from directory listings keyed by directory path ("" is the root). */
function index(listings: ReadonlyMap<string, Listing>) {
  const nodes = new Map<string, Node>([[ROOT, node("", true)]]);
  const children = new Map<string, string[]>();
  for (const [directory, listing] of listings) {
    const ids: string[] = [];
    for (const path of listing.directories) {
      nodes.set(path, node(path, true));
      ids.push(path);
    }
    for (const { path } of listing.entries) {
      nodes.set(path, node(path, false));
      ids.push(path);
    }
    children.set(directory || ROOT, ids);
  }
  return { nodes, children };
}

/** Files whose path contains `query`, with their folders, all expanded. */
function searchIndex(snapshot: Listing, query: string) {
  const needle = query.trim().toLowerCase();
  const matches = snapshot.entries.filter(({ path }) =>
    path.toLowerCase().includes(needle),
  );
  const folders = new Set<string>();
  for (const { path } of matches)
    for (let folder = parentOf(path); folder; folder = parentOf(folder))
      folders.add(folder);
  const listings = new Map<
    string,
    { directories: string[]; entries: { path: string }[] }
  >();
  const listing = (path: string) => {
    let value = listings.get(path);
    if (!value) listings.set(path, (value = { directories: [], entries: [] }));
    return value;
  };
  listing("");
  for (const folder of [...folders].sort()) {
    listing(folder);
    listing(parentOf(folder)).directories.push(folder);
  }
  for (const match of matches)
    listing(parentOf(match.path)).entries.push(match);
  return {
    ...index(listings),
    expanded: [ROOT, ...folders],
    empty: matches.length === 0,
  };
}

// Extension tints come from the shared indicator tokens, so both themes resolve them.
const tones = {
  purple:
    "border-indicator-purple/30 bg-indicator-purple/10 text-indicator-purple",
  blue: "border-indicator-blue/30 bg-indicator-blue/10 text-indicator-blue",
  cyan: "border-indicator-cyan/30 bg-indicator-cyan/10 text-indicator-cyan",
  green: "border-indicator-green/30 bg-indicator-green/10 text-indicator-green",
  amber: "border-indicator-amber/30 bg-indicator-amber/10 text-indicator-amber",
  orange:
    "border-indicator-orange/30 bg-indicator-orange/10 text-indicator-orange",
  magenta:
    "border-indicator-magenta/30 bg-indicator-magenta/10 text-indicator-magenta",
  teal: "border-indicator-teal/30 bg-indicator-teal/10 text-indicator-teal",
  muted: "border-indicator-muted/30 bg-indicator-muted/10 text-indicator-muted",
};
const extensionTones: Partial<Record<string, keyof typeof tones>> = {
  tea: "purple",
  ts: "blue",
  tsx: "blue",
  js: "blue",
  jsx: "blue",
  mjs: "blue",
  docx: "blue",
  py: "cyan",
  r: "cyan",
  sql: "cyan",
  json: "amber",
  yaml: "amber",
  yml: "amber",
  toml: "amber",
  ini: "amber",
  csv: "green",
  tsv: "green",
  xlsx: "green",
  pptx: "orange",
  mp3: "orange",
  m4a: "orange",
  wav: "orange",
  ogg: "orange",
  mp4: "orange",
  webm: "orange",
  pdf: "magenta",
  png: "teal",
  jpg: "teal",
  jpeg: "teal",
  gif: "teal",
  webp: "teal",
  avif: "teal",
  svg: "teal",
};

/** The file's extension as a tinted pill; names without one keep a plain file icon. Fills the disclosure and icon slots so names align with folders. */
function FileBadge({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0)
    return (
      <span aria-hidden className="flex w-9 shrink-0 justify-end pr-0.5">
        <File className="size-4 text-muted-foreground" />
      </span>
    );
  const extension = name.slice(dot + 1).toLowerCase();
  return (
    <span
      aria-hidden
      className={cn(
        "w-9 shrink-0 overflow-hidden rounded-sm border text-center text-2xs font-semibold uppercase leading-4",
        tones[extensionTones[extension] ?? "muted"],
      )}
    >
      {extension.slice(0, 4)}
    </span>
  );
}

/** Callbacks owned by the view; the tree never writes files itself. */
export type FileTreeActions = {
  onOpen: (path: string) => void;
  onCreate: (kind: CreateKind, directory: string) => void;
  onDelete: (entry: TreeEntry) => void;
  onMove: (entry: TreeEntry, to: string) => void;
  /** False while an open tab under the entry has unsaved or saving edits. */
  canMove: (entry: TreeEntry) => boolean;
};

type RowAction = {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
};

function rowActions(
  entry: Node,
  actions: FileTreeActions,
  shell: ReturnType<typeof useWorkspaceShell>,
  rename: () => void,
): RowAction[] {
  const shared: RowAction[] = [
    {
      label: "Rename",
      icon: <Pencil />,
      onSelect: rename,
      disabled: !actions.canMove(entry),
    },
    {
      label: "Copy path",
      icon: <Copy />,
      onSelect: () => shell.copy(entry.path),
    },
    {
      label: "Reveal in Finder",
      icon: <FolderOpen />,
      onSelect: () => shell.reveal(entry.path),
    },
    {
      label: "Delete",
      icon: <Trash2 />,
      onSelect: () => actions.onDelete(entry),
    },
  ];
  return entry.folder
    ? [
        {
          label: "New file",
          icon: <FilePlus />,
          onSelect: () => actions.onCreate("file", entry.path),
        },
        {
          label: "New folder",
          icon: <FolderPlus />,
          onSelect: () => actions.onCreate("folder", entry.path),
        },
        ...shared,
      ]
    : shared;
}

function TreeRow({
  item,
  active,
  dirty,
  actions,
  shell,
  onQuickLook,
}: {
  item: ItemInstance<Node>;
  active: boolean;
  dirty: boolean;
  actions: FileTreeActions;
  shell: ReturnType<typeof useWorkspaceShell>;
  onQuickLook: () => void;
}) {
  const entry = item.getItemData();
  const level = item.getItemMeta().level;
  // Menus restore focus to their trigger on close; start renaming after that.
  const menu = rowActions(entry, actions, shell, () =>
    setTimeout(() => item.startRenaming()),
  );
  // Row buttons stay out of the tab order; the tree owns keyboard focus.
  const stop = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            {...item.getProps()}
            // Focus reached any other way (Tab, programmatic) still drives the tree's keys.
            onFocus={(event) => {
              if (event.target === event.currentTarget && !item.isFocused())
                item.setFocused();
            }}
            title={entry.path}
            className={cn(
              "group/row relative flex h-6 shrink-0 cursor-default select-none items-center gap-1.5 rounded-md pr-1 text-sm text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              active &&
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              item.isUnorderedDragTarget() &&
                "bg-sidebar-accent ring-1 ring-inset ring-sidebar-ring",
            )}
            style={{ paddingLeft: level * INDENT + 4 }}
          >
            {Array.from({ length: level }, (_, depth) => (
              <span
                key={depth}
                aria-hidden
                className="absolute inset-y-0 border-l border-sidebar-border"
                style={{ left: depth * INDENT + 10 }}
              />
            ))}
            {entry.folder ? (
              <>
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                    item.isExpanded() && "rotate-90",
                  )}
                />
                <Folder
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </>
            ) : (
              <FileBadge name={entry.name} />
            )}
            {item.isRenaming() ? (
              <input
                {...item.getRenameInputProps()}
                aria-label={`Rename ${entry.name}`}
                // Focused on mount so the menu's focus restore cannot end the edit.
                // eslint-disable-next-line jsx-a11y/no-autofocus -- Renaming is an explicit request to type a new name here.
                autoFocus
                onFocus={(event) => {
                  const dot = entry.folder ? -1 : entry.name.lastIndexOf(".");
                  event.currentTarget.setSelectionRange(
                    0,
                    dot > 0 ? dot : entry.name.length,
                  );
                }}
                onClick={stop}
                className="min-w-0 flex-1 rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-sidebar-ring"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            )}
            {dirty ? (
              <span
                role="img"
                aria-label="Unsaved changes"
                className="size-1.5 shrink-0 rounded-full bg-foreground/60"
              />
            ) : null}
            {/* Takes no width until needed, so names use the whole row. */}
            <div className="hidden shrink-0 items-center group-hover/row:flex group-focus-visible/row:flex has-[[data-state=open]]:flex">
              {entry.folder ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  className="size-5"
                  aria-label={`New file in ${entry.name}`}
                  onClick={(event) => {
                    stop(event);
                    actions.onCreate("file", entry.path);
                  }}
                >
                  <Plus />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  className="size-5"
                  aria-label={`Quick Look ${entry.name}`}
                  onClick={(event) => {
                    stop(event);
                    onQuickLook();
                  }}
                >
                  <Eye />
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    className="size-5"
                    aria-label={`More actions for ${entry.name}`}
                    onClick={stop}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" onClick={stop}>
                  {menu.map((action) => (
                    <DropdownMenuItem
                      key={action.label}
                      disabled={action.disabled}
                      onSelect={action.onSelect}
                    >
                      {action.icon}
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        }
      />
      <ContextMenuContent>
        {menu.map((action) => (
          <ContextMenuItem
            key={action.label}
            disabled={action.disabled}
            onClick={action.onSelect}
          >
            {action.icon}
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One Workspace's files: folders load lazily while expanded and stay live through
 * Query/SSE; a non-empty `search` instead filters the recursive listing with every
 * matching folder open. The tree owns expansion and focus, reporting focus through
 * `onFocus`; rename and drops report through `actions`. Remount it (a new `key`) to
 * collapse every folder, as switching workspaces does.
 * @example <FileTree key={workspace.id} workspace={workspace} search="" onFocus={setFocused} dirty={new Set()} {...actions} />
 */
export function FileTree({
  workspace,
  active,
  dirty,
  search,
  onFocus,
  ...actions
}: FileTreeActions & {
  workspace: { id: string; root: string };
  /** The active tab's path when it belongs to this workspace. */
  active?: string;
  /** Paths in this workspace whose open tab has unsaved edits. */
  dirty: ReadonlySet<string>;
  search: string;
  /** Reports the keyboard-focused row; the view targets new files at it. */
  onFocus: (entry: TreeEntry | null) => void;
}) {
  const { transport } = useWorkspaceView();
  const shell = useWorkspaceShell(workspace.root);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const searching = search.trim().length > 0;
  // One Quick Look at a time, positioned against its row.
  const [quickLook, setQuickLook] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const toggleQuickLook = (item: ItemInstance<Node>) => {
    const entry = item.getItemData();
    if (entry.folder) return;
    anchor.current = item.getElement() ?? null;
    setQuickLook((current) => (current === entry.path ? null : entry.path));
  };
  // Each expanded folder keeps one live listing; collapsing releases it.
  const directories = useMemo(() => ["", ...expanded], [expanded]);
  const listings = useQueries({
    queries: directories.map((path) =>
      workspaceDirectoryQueryOptions(transport, workspace.id, path),
    ),
    combine: pickListings,
  });
  const whole = useQuery({
    ...workspaceTreeQueryOptions(transport, workspace.id),
    enabled: searching,
  });
  const root = listings[0]!;
  // A folder renamed or deleted while expanded lists as missing; close it and
  // its descendants instead of reporting it.
  useEffect(() => {
    const gone = directories.filter(
      (path, position) =>
        path && listings[position]?.data?.status === "missing",
    );
    if (gone.length)
      setExpanded((current) =>
        current.filter(
          (path) =>
            !gone.some(
              (folder) => path === folder || path.startsWith(`${folder}/`),
            ),
        ),
      );
  }, [directories, listings]);
  const failure = listings.find(
    ({ data }, position) =>
      data !== undefined &&
      data.status !== "ready" &&
      (position === 0 || data.status !== "missing"),
  )?.data;
  useErrorToast(
    failure?.status === "missing"
      ? "Workspace folder is missing."
      : failure?.status === "unavailable"
        ? failure.reason
        : undefined,
    {
      id: `workspace:${workspace.id}`,
      title: "Couldn’t open folder",
      retry: () => listings.forEach(({ refetch }) => void refetch()),
    },
  );
  const view = useMemo(() => {
    if (searching && whole.data?.status === "ready")
      return searchIndex(whole.data, search);
    const ready = new Map<string, Listing>();
    directories.forEach((path, position) => {
      const data = listings[position]?.data;
      if (data?.status === "ready") ready.set(path, data);
    });
    return { ...index(ready), expanded: [ROOT, ...expanded], empty: false };
  }, [searching, whole.data, search, directories, listings, expanded]);
  const destination = (target: DragTarget<Node>) => {
    const entry = target.item.getItemData();
    return entry.folder ? entry.path : parentOf(entry.path);
  };
  const tree = useTree<Node>({
    rootItemId: ROOT,
    state: { expandedItems: view.expanded, focusedItem: focused },
    // The tree may re-apply unchanged state while rendering; only store changes.
    setExpandedItems: (update) => {
      if (searching) return;
      const next = (
        typeof update === "function" ? update(view.expanded) : update
      ).filter((id) => id !== ROOT);
      if (next.join("\0") !== expanded.join("\0")) setExpanded(next);
    },
    setFocusedItem: (update) => {
      const id = typeof update === "function" ? update(focused) : update;
      if (id === focused) return;
      setFocused(id);
      const entry = id ? view.nodes.get(id) : undefined;
      onFocus(entry ? { path: entry.path, folder: entry.folder } : null);
    },
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().folder,
    dataLoader: {
      getItem: (id) => view.nodes.get(id) ?? node(id, false),
      getChildren: (id) => view.children.get(id) ?? [],
    },
    onPrimaryAction: (item) => {
      const entry = item.getItemData();
      if (!entry.folder) actions.onOpen(entry.path);
    },
    canRename: (item) =>
      item.getId() !== ROOT && actions.canMove(item.getItemData()),
    onRename: (item, value) => {
      const entry = item.getItemData();
      const name = value.trim();
      if (!name || name === entry.name || name.includes("/")) return;
      actions.onMove(entry, join(parentOf(entry.path), name));
    },
    canReorder: false,
    canDrop: (items, target) => {
      const [item] = items;
      if (!item || items.length !== 1 || searching) return false;
      const entry = item.getItemData();
      const directory = destination(target);
      return (
        parentOf(entry.path) !== directory &&
        !(
          entry.folder &&
          (directory === entry.path || directory.startsWith(`${entry.path}/`))
        ) &&
        actions.canMove(entry)
      );
    },
    onDrop: (items, target) => {
      const entry = items[0]?.getItemData();
      if (entry) actions.onMove(entry, join(destination(target), entry.name));
    },
    indent: INDENT,
    hotkeys: {
      customQuickLook: {
        hotkey: "Space",
        preventDefault: true,
        handler: (_, tree) => toggleQuickLook(tree.getFocusedItem()),
      },
      customOpen: {
        hotkey: "Enter",
        handler: (_, tree) => {
          const item = tree.getFocusedItem();
          if (!item.isFolder()) item.primaryAction();
          else if (item.isExpanded()) item.collapse();
          else item.expand();
        },
      },
    },
    features: [
      syncDataLoaderFeature,
      hotkeysCoreFeature,
      renamingFeature,
      dragAndDropFeature,
    ],
  });
  // The sync loader reads `view`; rebuild whenever listings or expansion change.
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, view]);
  if (root.isPending)
    return (
      <p role="status" className="p-2 text-sm text-muted-foreground">
        Loading files…
      </p>
    );
  if (root.isError || root.data?.status !== "ready")
    return (
      <Button size="sm" variant="ghost" onClick={() => void root.refetch()}>
        Try again
      </Button>
    );
  if (searching && whole.isPending)
    return (
      <p role="status" className="p-2 text-sm text-muted-foreground">
        Searching files…
      </p>
    );
  if (searching && (whole.isError || whole.data?.status !== "ready"))
    return (
      <Button size="sm" variant="ghost" onClick={() => void whole.refetch()}>
        Try again
      </Button>
    );
  if (view.empty)
    return (
      <p className="p-2 text-sm text-muted-foreground">No matching files.</p>
    );
  return (
    <div
      {...tree.getContainerProps(`${workspaceName(workspace.root)} files`)}
      className="flex flex-col outline-none"
    >
      {tree.getItems().map((item) => {
        const entry = item.getItemData();
        return (
          <TreeRow
            key={item.getKey()}
            item={item}
            active={!entry.folder && entry.path === active}
            dirty={!entry.folder && dirty.has(entry.path)}
            actions={actions}
            shell={shell}
            onQuickLook={() => toggleQuickLook(item)}
          />
        );
      })}
      <Popover
        open={quickLook !== null}
        onOpenChange={(open) => {
          if (!open) setQuickLook(null);
        }}
      >
        <PopoverAnchor virtualRef={anchor} />
        {quickLook !== null ? (
          <PopoverContent
            side="right"
            align="start"
            className="w-80 p-3"
            aria-label={`Quick Look ${basename(quickLook)}`}
            // Keep keyboard focus in the tree so Space closes the preview again.
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <QuickLook
              workspaceId={workspace.id}
              path={quickLook}
              onOpen={() => {
                setQuickLook(null);
                actions.onOpen(quickLook);
              }}
            />
          </PopoverContent>
        ) : null}
      </Popover>
    </div>
  );
}
