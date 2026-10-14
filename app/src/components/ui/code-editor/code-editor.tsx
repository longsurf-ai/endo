// Purpose: Share the bundled Monaco runtime, readiness, theme and editor defaults across app surfaces.
import MonacoEditor, { type EditorProps } from "@monaco-editor/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { monacoReady } from "@openchart/app/lib/monaco/monaco";
import { useDarkTheme } from "@openchart/app/lib/theme/theme";
import "./code-editor.css";

/** Mount a Monaco model using the shared bundled runtime; each instance owns its model unless keepCurrentModel is set.
 * Initialization failures stay visible. Workspace callers supply their own LSP/focus callbacks.
 * @example <CodeEditor language="tea" value={source} options={{ readOnly: true }} />
 */
export function CodeEditor({ options, ...props }: Omit<EditorProps, "theme">) {
  const current = useRef(props);
  current.current = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error>();
  const dark = useDarkTheme();
  // Hovers, suggestions and parameter hints are fixed-position overflow
  // widgets. Under a transformed ancestor (a dashboard grid item, a dialog)
  // `fixed` is measured from that ancestor, not the screen, so they would
  // render away from the cursor; they live under document.body instead. The
  // `monaco-editor` class carries Monaco's widget styles and theme colors;
  // `code-editor-overflow` scopes the app's hover styles (code-editor.css).
  const [overflowWidgets] = useState(() => {
    const node = document.createElement("div");
    node.className = "monaco-editor code-editor-overflow";
    return node;
  });
  useLayoutEffect(() => {
    document.body.append(overflowWidgets);
    return () => overflowWidgets.remove();
  }, [overflowWidgets]);
  useEffect(() => {
    let active = true;
    void monacoReady.then(
      () => {
        if (active) setReady(true);
      },
      (cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (error)
    return (
      <p role="status">Editor unavailable. Reload the app to try again.</p>
    );
  if (!ready) return <p role="status">Opening editor…</p>;
  return (
    <MonacoEditor
      height="100%"
      {...props}
      onMount={(editor, monaco) => {
        // Monaco React reuses a retained model without applying its initial
        // controlled value. Bind the caller's current text before edit listeners
        // attach; Workspace drafts remain authoritative through that value.
        const { value, onMount } = current.current;
        if (value !== undefined && editor.getValue() !== value)
          editor.setValue(value);
        onMount?.(editor, monaco);
      }}
      // Monaco's theme is global: every editor must use the applied app theme.
      theme={dark ? "Default Dark+" : "Default Light+"}
      options={{
        automaticLayout: true,
        minimap: { enabled: false },
        glyphMargin: false,
        lineNumbersMinChars: 2,
        scrollBeyondLastLine: false,
        fontSize: 13,
        padding: { top: 12 },
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode: overflowWidgets,
        ...options,
      }}
    />
  );
}
