// Purpose: Compose the sidebar file explorer and Dockview's single-group tabs.
// Preserve menu structure and shared theme tokens.
// The explorer follows its available container width, including beside Copilot.
import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useAssistantContext } from "@assistant-ui/react";
import { useUnsavedChanges } from "@openchart/app/lib/unsaved-changes/unsaved-changes";
import { useDarkTheme } from "@openchart/app/lib/theme/theme";
import {
  DockviewReact,
  DockviewDefaultTab,
  themeDark,
  themeLight,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import { FilePlus, Files, FolderPlus, Plus, Search, X } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@openchart/app/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { Button } from "@openchart/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@openchart/app/components/ui/dialog";
import {
  defaultWorkspaceQueryOptions,
  useWorkspaceFileMutations,
  workspaceName,
  workspacesQueryOptions,
} from "@openchart/app/lib/workspace/workspace";
import { cn } from "@openchart/app/utils/cn";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import {
  createWorkspaceViewStore,
  type WorkspaceViewStore,
} from "../stores/view";
import { WorkspaceContext, useWorkspaceView } from "./context";
import { FileTree, type CreateKind, type TreeEntry } from "./file-tree";
import { CreateEntryDialog } from "./create-entry-dialog";
import { useWorkspaceShell } from "../hooks/use-workspace-shell";
import { WorkspaceSwitcher } from "./workspace-switcher";
import {
  DeleteFileDialog,
  DeleteFolderDialog,
  ForgetWorkspaceDialog,
} from "./remove-entry-dialog";
import {
  FilePanel,
  openWorkspaceFile,
  type FilePanelParams,
} from "@openchart/app/features/workspace/components/file-panel/file-panel";
import "dockview-react/dist/styles/dockview.css";
import "./workspace-view.css";

const components = { file: FilePanel };
const tabReorderOnly = { resolve: () => null };
function EmptyFiles() {
  return (
    <div className="relative flex size-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <div className="absolute left-1 top-1">
        <HeaderNavigation />
      </div>
      <div className="absolute right-1 top-1">
        <HeaderActions />
      </div>
      <Files className="size-8" />
      <p>Choose a file from the sidebar.</p>
    </div>
  );
}
/** The file-tree toggle and the view's own actions; file actions live in each panel's toolbar. */
function HeaderActions() {
  const { actions, collapsible } = useWorkspaceView();
  const { isMobile } = useSidebar();
  return (
    <div className="flex h-full items-center gap-1 px-1">
      {/* Shown whenever the panel can close: in widgets and the compact overlay. */}
      {collapsible || isMobile ? (
        <SidebarTrigger
          aria-label="Toggle files"
          title="Toggle files (⌘B / Ctrl+B)"
        />
      ) : null}
      {actions}
    </div>
  );
}
function HeaderNavigation() {
  const { navigation } = useWorkspaceView();
  const { open, isMobile } = useSidebar();
  return !open || isMobile ? (
    <div className="flex h-full items-center px-1">{navigation}</div>
  ) : null;
}
function FileTab(props: IDockviewPanelHeaderProps<FilePanelParams>) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <DockviewDefaultTab
        {...props}
        closeActionOverride={() => {
          if (props.params.saving) return;
          if (props.params.dirty) setConfirm(true);
          else props.api.close();
        }}
      />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {props.params.path} has changes that haven’t been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => props.api.close()}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
/** True for the path itself or anything inside it when it is a folder. */
const within = (path: string, entry: TreeEntry) =>
  path === entry.path || (entry.folder && path.startsWith(`${entry.path}/`));
/** True while an open tab owns an unsaved draft or in-flight save. @example if (hasUnsavedFiles(api)) confirmNavigation(); */
function hasUnsavedFiles(api: DockviewApi | undefined) {
  return (
    api?.panels.some((panel) => panel.params?.dirty || panel.params?.saving) ??
    false
  );
}
/** File explorer for one registered Workspace at a time, with shared draft protection. The docked file panel stays open and only resizes unless `collapsible`; a page `title` heads it at the shared 60px header height. @example <WorkspaceView transport={transport} title="Workspace" /> */
export function WorkspaceView({
  file,
  onFileOpen,
  scopeId,
  collapsible = false,
  title,
  transport,
  actions,
  navigation,
}: {
  /** Opened and scrolled into view once Dockview is ready, then reported through `onFileOpen`. */
  file?: Pick<FilePanelParams, "workspaceId" | "path">;
  onFileOpen?: () => void;
  scopeId?: string;
  collapsible?: boolean;
  title?: string;
  transport: AppTransport;
  actions?: ReactNode;
  navigation?: ReactNode;
}) {
  const instanceId = useId();
  const saves = useRef(new Map<string, () => Promise<void>>());
  const dark = useDarkTheme();
  // The page shares one remembered Workspace; each widget placement keeps its own.
  const [view] = useState(() =>
    createWorkspaceViewStore(scopeId ? `widget:${scopeId}` : "page"),
  );
  const context = useMemo(
    () => ({
      transport,
      instanceId,
      collapsible,
      dark,
      actions,
      navigation,
      saves,
    }),
    [transport, instanceId, collapsible, dark, actions, navigation],
  );
  return (
    <WorkspaceContext.Provider value={context}>
      <SidebarProvider embedded open={collapsible ? undefined : true}>
        <WorkspaceContents
          transport={transport}
          dark={dark}
          view={view}
          file={file}
          onFileOpen={onFileOpen}
          scopeId={scopeId ?? instanceId}
          title={title}
        />
      </SidebarProvider>
    </WorkspaceContext.Provider>
  );
}
function WorkspaceContents({
  file,
  onFileOpen,
  scopeId,
  title,
  transport,
  dark,
  view,
}: {
  file?: Pick<FilePanelParams, "workspaceId" | "path">;
  onFileOpen?: () => void;
  scopeId: string;
  title?: string;
  transport: AppTransport;
  dark: boolean;
  view: WorkspaceViewStore;
}) {
  const query = useQuery(workspacesQueryOptions(transport));
  const defaultWorkspace = useQuery(defaultWorkspaceQueryOptions(transport));
  const [removing, setRemoving] = useState<
    | { kind: "file" | "folder"; workspaceId: string; path: string }
    | { kind: "workspace"; workspaceId: string; root: string }
  >();
  const [creating, setCreating] = useState<{
    kind: CreateKind;
    directory: string;
  }>();
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState<TreeEntry | null>(null);
  // Collapse all remounts the tree, which starts with every folder closed.
  const [collapses, collapse] = useReducer((count: number) => count + 1, 0);
  const { isMobile, setOpenMobile } = useSidebar();
  const { navigation, collapsible } = useWorkspaceView();
  const [api, setApi] = useState<DockviewApi>();
  // Dockview's layout event covers tabs opening, closing, activating and changing params.
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!api) return;
    const listener = api.onDidLayoutChange(refresh);
    return () => listener.dispose();
  }, [api]);
  const tabs = (api?.panels ?? []).map(
    (panel) => panel.params as FilePanelParams,
  );
  const active = api?.activePanel?.params as FilePanelParams | undefined;
  const fileWorkspaceId = file?.workspaceId;
  const filePath = file?.path;
  const files = useRef<HTMLDivElement>(null);
  // The remembered choice wins while it stays registered, then the default,
  // then the first registration.
  const remembered = useStore(view, (state) => state.workspaceId);
  const registered = query.data ?? [];
  const workspace =
    registered.find(({ id }) => id === remembered) ??
    registered.find(({ id }) => id === defaultWorkspace.data) ??
    registered[0];
  // Every switch, from the menu or a file request, starts without search or focus.
  const [shown, setShown] = useState(workspace?.id);
  if (shown !== workspace?.id) {
    setShown(workspace?.id);
    setSearch("");
    setFocused(null);
  }
  const mutations = useWorkspaceFileMutations(transport, workspace?.id ?? "");
  const shell = useWorkspaceShell(workspace?.root);
  useAssistantContext({
    getContext: () =>
      JSON.stringify({
        view: "workspace",
        file: active
          ? { workspaceId: active.workspaceId, path: active.path }
          : null,
      }),
  });
  const changes = useUnsavedChanges();
  if (!changes)
    throw new Error("WorkspaceView requires UnsavedChangesProvider");
  useEffect(
    () => changes.register(scopeId, () => hasUnsavedFiles(api)),
    [changes, scopeId, api],
  );
  useEffect(() => {
    if (!api || !fileWorkspaceId || !filePath) return;
    openWorkspaceFile(api, fileWorkspaceId, filePath);
    // A request for another workspace's file also shows that workspace.
    view.setState({ workspaceId: fileWorkspaceId });
    // A dashboard widget may sit below the fold; jsdom has no scrollIntoView.
    files.current?.scrollIntoView?.({ block: "nearest" });
    onFileOpen?.();
  }, [api, fileWorkspaceId, filePath, onFileOpen, view]);
  const openFile = (workspaceId: string, path: string) => {
    if (!api) return;
    openWorkspaceFile(api, workspaceId, path);
    if (isMobile) setOpenMobile(false);
  };
  // Tabs inside an entry, excluding other workspaces' files with the same path.
  const tabsWithin = (owner: string, entry: TreeEntry) =>
    (api?.panels ?? []).filter((panel) => {
      const params = panel.params as FilePanelParams;
      return params.workspaceId === owner && within(params.path, entry);
    });
  const canMove = (entry: TreeEntry) =>
    !!workspace &&
    tabsWithin(workspace.id, entry).every((panel) => {
      const params = panel.params as FilePanelParams;
      return !params.dirty && !params.saving;
    });
  const move = (entry: TreeEntry, to: string) => {
    if (!workspace || !canMove(entry)) return;
    const owner = workspace.id;
    // Tabs under the entry stay read-only while it moves, so no draft starts
    // at a path that is about to disappear; then each follows its file.
    for (const panel of tabsWithin(owner, entry))
      panel.api.updateParameters({ moving: true });
    mutations.move.mutate(
      { from: entry.path, to },
      {
        onSuccess: () => {
          for (const panel of tabsWithin(owner, entry)) {
            const { path } = panel.params as FilePanelParams;
            panel.api.close();
            if (api)
              openWorkspaceFile(api, owner, to + path.slice(entry.path.length));
          }
        },
        onError: () => {
          for (const panel of tabsWithin(owner, entry))
            panel.api.updateParameters({ moving: false });
        },
      },
    );
  };
  const finishRemoval = () => {
    if (!removing) return;
    for (const panel of [...(api?.panels ?? [])]) {
      const params = panel.params as FilePanelParams;
      if (
        params.workspaceId === removing.workspaceId &&
        (removing.kind === "workspace" ||
          within(params.path, {
            path: removing.path,
            folder: removing.kind === "folder",
          }))
      ) {
        panel.api.close();
      }
    }
    setRemoving(undefined);
  };
  // New files land in the focused folder, or beside the focused file.
  const target = focused
    ? focused.folder
      ? focused.path
      : focused.path.split("/").slice(0, -1).join("/")
    : "";
  const name = workspace ? workspaceName(workspace.root) : "workspace";
  return (
    <>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader
          className={cn(
            "flex-row items-center gap-1 px-2 pb-0",
            title ? "h-11 pt-2" : "h-9 pt-1",
          )}
        >
          {navigation}
          {title ? <h1 className="sr-only">{title}</h1> : null}
          <WorkspaceSwitcher
            workspaces={registered}
            selected={workspace}
            defaultId={defaultWorkspace.data}
            onSelect={(id) => view.setState({ workspaceId: id })}
            onReveal={() => shell.reveal("")}
            onCollapse={collapse}
            onForget={(selected) =>
              setRemoving({
                kind: "workspace",
                workspaceId: selected.id,
                root: selected.root,
              })
            }
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto size-7 shrink-0"
                aria-label="Add"
                disabled={!workspace}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  setCreating({ kind: "file", directory: target })
                }
              >
                <FilePlus /> New file
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  setCreating({ kind: "folder", directory: target })
                }
              >
                <FolderPlus /> New folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="pt-1">
            <SidebarGroupContent>
              {query.isPending ? (
                <p role="status" className="p-2 text-sm text-muted-foreground">
                  Loading workspaces…
                </p>
              ) : null}
              {query.isError ? (
                <div className="p-2 text-sm">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void query.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
              {workspace ? (
                <FileTree
                  key={`${workspace.id}:${collapses}`}
                  workspace={workspace}
                  active={
                    active?.workspaceId === workspace.id
                      ? active.path
                      : undefined
                  }
                  dirty={
                    new Set(
                      tabs
                        .filter(
                          (tab) =>
                            tab.dirty && tab.workspaceId === workspace.id,
                        )
                        .map((tab) => tab.path),
                    )
                  }
                  search={search}
                  onFocus={setFocused}
                  onOpen={(path) => openFile(workspace.id, path)}
                  onCreate={(kind, directory) =>
                    setCreating({ kind, directory })
                  }
                  onDelete={(entry) =>
                    setRemoving({
                      kind: entry.folder ? "folder" : "file",
                      workspaceId: workspace.id,
                      path: entry.path,
                    })
                  }
                  onMove={move}
                  canMove={canMove}
                />
              ) : null}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="p-2 pt-0">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <SidebarInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                if (search) setSearch("");
                else event.currentTarget.blur();
              }}
              disabled={!workspace}
              aria-label="Search files"
              placeholder={`Search ${name}`}
              autoComplete="off"
              spellCheck={false}
              className="h-7 pl-7 pr-7"
            />
            {search ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2"
                aria-label="Clear file search"
                onClick={() => setSearch("")}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </SidebarFooter>
        <SidebarRail
          {...(collapsible
            ? {}
            : { title: "Resize files", "aria-label": "Resize files" })}
        />
      </Sidebar>
      <div
        ref={files}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <div className="min-h-0 flex-1">
          <DockviewReact
            className="workspace-files h-full"
            components={components}
            defaultTabComponent={FileTab}
            prefixHeaderActionsComponent={HeaderNavigation}
            rightHeaderActionsComponent={HeaderActions}
            watermarkComponent={EmptyFiles}
            theme={dark ? themeDark : themeLight}
            disableFloatingGroups
            dndStrategy="pointer"
            dropPositionResolver={tabReorderOnly}
            onReady={(event) => {
              setApi(event.api);
            }}
          />
        </div>
      </div>
      {creating && workspace ? (
        <CreateEntryDialog
          {...creating}
          workspaceId={workspace.id}
          onClose={() => setCreating(undefined)}
          onCreated={(path) => openFile(workspace.id, path)}
        />
      ) : null}
      {removing?.kind === "file" ? (
        <DeleteFileDialog
          {...removing}
          onDeleted={finishRemoval}
          onClose={() => setRemoving(undefined)}
        />
      ) : removing?.kind === "folder" ? (
        <DeleteFolderDialog
          {...removing}
          onDeleted={finishRemoval}
          onClose={() => setRemoving(undefined)}
        />
      ) : removing?.kind === "workspace" ? (
        <ForgetWorkspaceDialog
          {...removing}
          onForgot={finishRemoval}
          onClose={() => setRemoving(undefined)}
        />
      ) : null}
    </>
  );
}
