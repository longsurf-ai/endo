// Purpose: Select a composer's Workspace without changing its files or registry.
import { useQuery } from "@tanstack/react-query";
import { BriefcaseBusiness, ChevronDownIcon } from "lucide-react";
import { modelSelectorTriggerVariants } from "@openchart/app/components/ui/model-selector/model-selector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { cn } from "@openchart/app/utils/cn";
import {
  workspaceName,
  workspaceQueryOptions,
  workspacesQueryOptions,
} from "@openchart/app/lib/workspace/workspace";

/**
 * Reads registered workspaces and reports a local composer choice to its owner.
 * The button and menu show the last folder name, truncated to fit.
 * @example <WorkspacePicker transport={transport} workspaceId={id} onChange={setId} disabled={pending} />
 */
export function WorkspacePicker({
  transport,
  workspaceId,
  onChange,
  disabled,
}: {
  transport: AppTransport;
  workspaceId?: string;
  onChange: (workspaceId: string) => void;
  disabled: boolean;
}) {
  const workspaces = useQuery(workspacesQueryOptions(transport));
  const workspace = useQuery({
    ...workspaceQueryOptions(transport, workspaceId ?? ""),
    enabled: workspaceId !== undefined,
  });
  const root =
    workspace.data?.root ??
    workspaces.data?.find((item) => item.id === workspaceId)?.root;
  const label = root ? workspaceName(root) : "Workspace";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          modelSelectorTriggerVariants({ variant: "ghost", size: "sm" }),
          "min-w-0 max-w-full",
        )}
        disabled={disabled}
        aria-label={`Workspace: ${label}`}
        title={root}
      >
        <span className="flex min-w-0 items-center gap-2">
          <BriefcaseBusiness className="size-3.5" />
          <span className="max-w-[12ch] truncate font-medium">{label}</span>
        </span>
        <ChevronDownIcon className="size-4 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        {workspaces.isError ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                void workspaces.refetch();
              }}
            >
              Try again
            </DropdownMenuItem>
          </>
        ) : workspaces.isPending ? (
          <DropdownMenuItem disabled>Loading workspaces…</DropdownMenuItem>
        ) : workspaces.data.length === 0 ? (
          <DropdownMenuItem disabled>
            No registered workspaces.
          </DropdownMenuItem>
        ) : (
          <DropdownMenuRadioGroup
            value={workspaceId ?? ""}
            onValueChange={onChange}
          >
            {workspaces.data.map((item) => (
              <DropdownMenuRadioItem
                key={item.id}
                value={item.id}
                textValue={workspaceName(item.root)}
              >
                <span className="truncate">{workspaceName(item.root)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
