import { useErrorToast } from "@openchart/app/hooks/use-error-toast";
// Purpose: Show the current composer's Workspace files through assistant-ui mentions.
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  useAuiState,
  unstable_useLiveCompletionAdapter,
} from "@assistant-ui/react";
import { FileTextIcon } from "lucide-react";
import { Button } from "@openchart/app/components/ui/button";
import { ComposerTriggerPopover } from "@openchart/app/features/agent/components/composer/composer-trigger-popover.aui";
import {
  workspaceQueryOptions,
  workspaceTreeQueryOptions,
} from "@openchart/app/lib/workspace/workspace";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { cn } from "@openchart/app/utils/cn";

/**
 * Lists Workspace filenames only when assistant-ui requests completions and
 * filters relative paths locally. Its async adapter owns debounce and stale
 * results; Query shares one in-flight listing. No file contents are read.
 * @example <WorkspaceFileMentions transport={transport} workspaceId={workspaceId} />
 */
export function WorkspaceFileMentions({
  transport,
  workspaceId,
  className,
}: {
  transport: AppTransport;
  workspaceId: string;
  className?: string;
}) {
  const client = useQueryClient();
  const workspace = useQuery(workspaceQueryOptions(transport, workspaceId));
  const tree = workspaceTreeQueryOptions(transport, workspaceId);
  // Completions fill this entry; the disabled observer only reads its status.
  const files = useQuery({ ...tree, enabled: false });
  const root = workspace.data?.root;
  const text = useAuiState((state) => state.composer.text);
  const [retry, setRetry] = useState(0);
  const completions = unstable_useLiveCompletionAdapter({
    fetcher: async (query) => {
      // Every trigger reads current disk state, including unopened directories.
      const snapshot = await client.fetchQuery({ ...tree, staleTime: 0 });
      if (!root || snapshot.status !== "ready") return [];
      const needle = query.toLowerCase();
      return snapshot.entries
        .filter(({ path }) => path.toLowerCase().includes(needle))
        .map(({ path }) => ({
          id: `${root.replace(/\/$/, "")}/${path}`,
          type: "file",
          label: path,
        }));
    },
    cacheKey: JSON.stringify([workspaceId, root, text, retry]),
    enabled: root !== undefined,
  });
  const status = files.data?.status;
  const unavailable = status === "missing" || status === "unavailable";
  const failed = workspace.isError || files.isError || unavailable;
  useErrorToast(
    status === "missing"
      ? "Workspace folder is missing."
      : status === "unavailable"
        ? "Workspace directory unavailable."
        : undefined,
    {
      id: `workspace:${workspaceId}`,
      title: "Couldn’t search workspace files",
    },
  );
  return (
    <>
      <ComposerTriggerPopover
        char="@"
        aria-label="Workspace files"
        directive={{ formatter: directiveFormatter }}
        adapter={completions.adapter}
        fallbackIcon={FileTextIcon}
        isLoading={workspace.isPending || completions.isLoading}
        loadingLabel="Searching workspace files"
        emptyItemsLabel={
          failed ? "Couldn’t load workspace files." : "No matching files."
        }
        className={cn(
          "max-h-64 w-full overflow-y-auto [&_[role=option]]:break-all",
          className,
        )}
      />
      {failed ? (
        <p className="px-1 text-xs text-muted-foreground">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => {
              setRetry((value) => value + 1);
              void workspace.refetch();
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
    </>
  );
}
