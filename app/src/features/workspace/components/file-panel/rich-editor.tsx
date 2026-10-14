// Purpose: Show Markdown in Crepe or CSV/TSV as a table, with a Source tab editing the same file draft.
import { lazy, Suspense, useMemo, useState, type ComponentProps } from "react";
import { useErrorToast } from "@openchart/app/hooks/use-error-toast";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@openchart/app/components/ui/tabs";
import { LoadingFile, ToolbarControls } from "./file-panel";

const CodeEditor = lazy(() => import("./code-editor"));
const CrepeEditor = lazy(() => import("./crepe-editor"));
const OfficeViewer = lazy(() => import("./office-viewer"));

const views = {
  markdown: {
    label: "Edit",
    list: "Markdown view",
    failure: "Couldn’t open Markdown editor",
  },
  delimited: {
    label: "Table",
    list: "Table view",
    failure: "Couldn’t show this table",
  },
};

/** Parses only while the table tab is shown; the inactive tab unmounts. */
function Table({
  value,
  path,
  onError,
}: {
  value: string;
  path: string;
  onError: (reason: Error) => void;
}) {
  const bytes = useMemo(() => new TextEncoder().encode(value), [value]);
  return (
    <OfficeViewer
      bytes={bytes}
      format={/\.tsv$/i.test(path) ? "tsv" : "csv"}
      onError={onError}
    />
  );
}

/**
 * Markdown edits visually in Crepe and CSV/TSV shows a read-only table; Source edits
 * the same draft as text. A rich view that cannot show the file falls back to Source,
 * with a status for unsupported content or a retryable toast for failures.
 * @example <RichEditor viewer="markdown" {...editorProps} />
 */
export default function RichEditor({
  viewer,
  ...props
}: ComponentProps<typeof CodeEditor> & { viewer: "markdown" | "delimited" }) {
  const [mode, setMode] = useState<
    { view: "rich" } | { view: "source"; reason?: string | Error }
  >({ view: "rich" });
  const reason = mode.view === "source" ? mode.reason : undefined;
  const fallback = (reason: string | Error) =>
    setMode({ view: "source", reason });
  useErrorToast(reason instanceof Error ? reason : undefined, {
    id: `${viewer}:${props.workspaceId}:${props.path}`,
    title: views[viewer].failure,
    retry: () => setMode({ view: "rich" }),
  });
  return (
    <Tabs
      className="size-full min-h-0 gap-0"
      value={mode.view}
      onValueChange={(view) => {
        if (view === "rich" || view === "source") setMode({ view });
      }}
    >
      <ToolbarControls>
        {typeof reason === "string" ? (
          <p role="status" className="text-xs text-muted-foreground">
            {reason}
          </p>
        ) : null}
        {/* Portaled outside Tabs, so it sizes itself to sit inside the 32px toolbar. */}
        <TabsList
          aria-label={views[viewer].list}
          className="h-6 rounded-md p-0.5"
        >
          <TabsTrigger value="rich" className="text-xs">
            {views[viewer].label}
          </TabsTrigger>
          <TabsTrigger value="source" className="text-xs">
            Source
          </TabsTrigger>
        </TabsList>
      </ToolbarControls>
      <TabsContent value="rich" className="min-h-0">
        <Suspense fallback={<LoadingFile />}>
          {viewer === "markdown" ? (
            <CrepeEditor
              value={props.value}
              onChange={props.onChange}
              onUnavailable={fallback}
            />
          ) : (
            <Table value={props.value} path={props.path} onError={fallback} />
          )}
        </Suspense>
      </TabsContent>
      <TabsContent value="source" className="min-h-0">
        <Suspense fallback={<LoadingFile />}>
          <CodeEditor {...props} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
