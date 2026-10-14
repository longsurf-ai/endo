// Purpose: Pick the one registered Workspace a view shows, and manage registrations from the same menu.
import {
  ChevronsUpDown,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  ListCollapse,
} from "lucide-react";
import { Button } from "@openchart/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { useAppHost } from "@openchart/app/lib/host/host";
import {
  useCreateWorkspace,
  workspaceName,
} from "@openchart/app/lib/workspace/workspace";
import { useWorkspaceView } from "./context";

type Workspace = { id: string; root: string };

/**
 * Scheme-style Workspace picker sized to its name. Registering a folder selects it;
 * Forget is offered only for non-default registrations and never deletes files.
 * @example <WorkspaceSwitcher workspaces={list} selected={id} onSelect={select} onForget={forget} onReveal={reveal} onCollapse={collapse} />
 */
export function WorkspaceSwitcher({
  workspaces,
  selected,
  defaultId,
  onSelect,
  onForget,
  onReveal,
  onCollapse,
}: {
  workspaces: readonly Workspace[];
  selected?: Workspace;
  defaultId?: string;
  onSelect: (workspaceId: string) => void;
  onForget: (workspace: Workspace) => void;
  onReveal: () => void;
  onCollapse: () => void;
}) {
  const { transport } = useWorkspaceView();
  const { pickDirectory } = useAppHost();
  const register = useCreateWorkspace(transport, pickDirectory);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={selected?.root}
          aria-label={`Browse workspace: ${selected ? workspaceName(selected.root) : "none"}`}
          // Styled like the header's Widgets picker; sized to its name, it
          // shrinks and truncates when the row is narrow.
          className="h-7 min-w-0 shrink justify-start gap-1.5 px-2 font-medium"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Folder aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {selected ? workspaceName(selected.root) : "Workspace"}
          </span>
          <ChevronsUpDown
            aria-hidden
            className="shrink-0 text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          value={selected?.id}
          onValueChange={(id) => onSelect(id)}
        >
          {workspaces.map((workspace) => (
            <DropdownMenuRadioItem
              key={workspace.id}
              value={workspace.id}
              title={workspace.root}
            >
              <span className="truncate">{workspaceName(workspace.root)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!selected} onSelect={onReveal}>
          <FolderOpen /> Reveal in Finder
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCollapse}>
          <ListCollapse /> Collapse all
        </DropdownMenuItem>
        {selected && defaultId && selected.id !== defaultId ? (
          <DropdownMenuItem onSelect={() => onForget(selected)}>
            <FolderMinus /> Forget workspace
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={register.isPending}
          onSelect={() =>
            register.mutate(undefined, {
              onSuccess: (workspace) => {
                if (workspace) onSelect(workspace.id);
              },
            })
          }
        >
          <FolderPlus /> Add workspace…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
