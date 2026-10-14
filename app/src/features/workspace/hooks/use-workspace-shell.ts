// Purpose: Share the native actions every Workspace path offers: copy, Finder and the default app.
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { URI, Utils } from "vscode-uri";
import { useAppHost } from "@openchart/app/lib/host/host";

/**
 * Copy path, Reveal in Finder and Open in default app for workspace-relative paths
 * under `root` (`""` is the folder itself). Failures toast; the native actions fail
 * while `root` is still unknown, so callers disable them until `ready`.
 * @example const shell = useWorkspaceShell(workspace.root); shell.reveal("notes/today.md");
 */
export function useWorkspaceShell(root: string | undefined) {
  const { openPath, revealPath } = useAppHost();
  const absolute = (path: string) => {
    if (!root) throw new Error("The workspace folder is unavailable.");
    return Utils.joinPath(URI.file(root), path).fsPath;
  };
  const reveal = useMutation({
    meta: { errorTitle: "Couldn’t reveal in Finder" },
    mutationFn: (path: string) => revealPath(absolute(path)),
    retry: false,
  });
  const open = useMutation({
    meta: { errorTitle: "Couldn’t open in default app" },
    mutationFn: (path: string) => openPath(absolute(path)),
    retry: false,
  });
  return {
    ready: root !== undefined,
    opening: open.isPending,
    copy: (path: string) =>
      void navigator.clipboard
        .writeText(path)
        .catch(() => toast.error("Couldn’t copy to clipboard")),
    reveal: (path: string) => reveal.mutate(path),
    open: (path: string) => open.mutate(path),
  };
}
