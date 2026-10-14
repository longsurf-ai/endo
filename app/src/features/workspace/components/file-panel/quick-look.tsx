// Purpose: Preview one Workspace file without opening a tab: a small read-only view, its type and size, and Open.
import { useQuery } from "@tanstack/react-query";
import { Button } from "@openchart/app/components/ui/button";
import { workspaceFileQueryOptions } from "@openchart/app/lib/workspace/workspace";
import { useWorkspaceView } from "../context";
import { fileViewer } from "./viewers";
import {
  decodeBytes,
  FilePreview,
  isTextViewer,
  LoadingFile,
} from "./file-panel";

const PREVIEW_LINES = 40;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decoded byte count of a Base64 payload. */
const byteLength = (base64: string) =>
  Math.floor((base64.length * 3) / 4) -
  (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

/**
 * Quick Look card content for one file: the same viewers as its tab, read-only and
 * small, with the extension, size and an Open action. It shares the tab's cached
 * read; a failed read offers no retry here because Open shows the full error.
 * @example <QuickLook workspaceId={id} path="positions.xlsx" onOpen={openTab} />
 */
export function QuickLook({
  workspaceId,
  path,
  onOpen,
}: {
  workspaceId: string;
  path: string;
  onOpen: () => void;
}) {
  const { transport } = useWorkspaceView();
  const query = useQuery(
    workspaceFileQueryOptions(transport, workspaceId, path),
  );
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const file = query.data;
  const viewer = file && fileViewer(path, file.mediaType);
  const details = [
    dot > 0 ? name.slice(dot + 1).toUpperCase() : "File",
    file ? formatSize(byteLength(file.base64)) : undefined,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-3">
      <div className="h-52 overflow-hidden rounded-md border bg-background">
        {!file || !viewer ? (
          query.isError ? (
            <p className="p-3 text-xs text-muted-foreground">
              Couldn’t read this file.
            </p>
          ) : (
            <LoadingFile />
          )
        ) : viewer === "none" ? (
          // The card's own Open button stands in for the tab's default-app prompt.
          <p className="flex size-full items-center justify-center text-xs text-muted-foreground">
            No preview for this file type
          </p>
        ) : isTextViewer(viewer) ? (
          // A glance needs the first lines only; editing stays in the tab.
          <pre className="size-full overflow-hidden whitespace-pre p-2 font-mono text-2xs leading-4 text-foreground">
            {new TextDecoder()
              .decode(decodeBytes(file.base64))
              .split("\n")
              .slice(0, PREVIEW_LINES)
              .join("\n")}
          </pre>
        ) : (
          <FilePreview
            file={file}
            viewer={viewer}
            workspaceId={workspaceId}
            path={path}
          />
        )}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
        </div>
        <Button size="sm" onClick={onOpen}>
          Open
        </Button>
      </div>
    </div>
  );
}
