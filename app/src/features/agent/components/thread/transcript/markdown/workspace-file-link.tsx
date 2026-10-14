// Purpose: Render local file chips and open them in the Workspace or the system's default app.
import { useContext, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileTextIcon } from "lucide-react";
import { defaultUrlTransform, type UrlTransform } from "react-markdown";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { DirectiveChip } from "@openchart/app/features/agent/components/thread/transcript/directive-text/directive-text";
import { useAppHost } from "@openchart/app/lib/host/host";
import {
  WorkspaceFileNavigation,
  workspacesQueryOptions,
  workspaceTreeQueryOptions,
} from "@openchart/app/lib/workspace/workspace";

/** Preserve file hrefs for Workspace validation; other URLs retain Markdown's sanitizer.
 * @example <MarkdownTextPrimitive urlTransform={workspaceFileUrlTransform} />
 */
export const workspaceFileUrlTransform: UrlTransform = (url, key, node) =>
  node.tagName === "a" && key === "href" && /^file:/i.test(url)
    ? url
    : defaultUrlTransform(url);

function localFile(href: string, root: string | undefined) {
  try {
    const base = new URL("file:///");
    if (root)
      base.pathname = `${root.replace(/\\/g, "/").replace(/\/$/, "").split("/").map(encodeURIComponent).join("/")}/`;
    const url = new URL(
      href.replace(/:\d+(?::\d+)?(?=[#?]|$)/, ""),
      root || href.startsWith("/") ? base : undefined,
    );
    const path = decodeURIComponent(url.pathname);
    return url.protocol === "file:" &&
      !url.host &&
      !path.includes("\0") &&
      !path.startsWith("//")
      ? path
      : undefined;
  } catch {
    return undefined;
  }
}

/** Render local file chips; clicks resolve against the reply's persisted cwd and current index.
 * Indexed files navigate inside the app; other local files use the system's default application.
 * Invalid paths and relative paths without a saved cwd remain plain text. Query failures never open externally.
 * @example <WorkspaceFileLink href="reports/note.md">Note</WorkspaceFileLink>
 */
export function WorkspaceFileLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const view = useAgentView();
  const savedRoot = useAuiState((s) => s.message.metadata.custom.workspaceRoot);
  const root = typeof savedRoot === "string" ? savedRoot : undefined;
  const path = localFile(href, root);
  const openFile = useContext(WorkspaceFileNavigation);
  const { openPath } = useAppHost();
  const client = useQueryClient();
  const open = useMutation({
    meta: { errorTitle: "Couldn’t open file" },
    retry: false,
    mutationFn: async (absolutePath: string) => {
      const prefix = root && `${root.replace(/\/$/, "")}/`;
      if (view && openFile && prefix && absolutePath.startsWith(prefix)) {
        const registry = await client.fetchQuery(
          workspacesQueryOptions(view.transport),
        );
        const workspace = registry.find((item) => item.root === root);
        if (workspace) {
          const files = await client.fetchQuery(
            workspaceTreeQueryOptions(view.transport, workspace.id),
          );
          if (files.status !== "ready")
            throw new Error("Workspace files are not ready. Try again.");
          const relativePath = absolutePath.slice(prefix.length);
          if (files.entries.some((entry) => entry.path === relativePath))
            return openFile({ workspaceId: workspace.id, path: relativePath });
        }
      }
      await openPath(absolutePath);
    },
  });
  if (!path) return <>{children}</>;
  return (
    <DirectiveChip
      directiveType="file"
      directiveId={path}
      label={path.slice(path.lastIndexOf("/") + 1) || path}
      icon={FileTextIcon}
      render={
        <button
          type="button"
          className="cursor-pointer"
          disabled={open.isPending}
          onClick={() => open.mutate(path)}
        />
      }
    />
  );
}
