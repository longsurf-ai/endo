// Purpose: Bind Workspace file models to the shared Monaco editor.
import { CodeEditor as Editor } from "@openchart/app/components/ui/code-editor";

/** Mount and focus one file model with automatic container sizing. @example <CodeEditor {...fileProps} /> */
export default function CodeEditor({
  path,
  value,
  readOnly = false,
  wordWrap = false,
  onChange,
}: {
  path: string;
  /** Identifies the file's Workspace for viewers that share these props. */
  workspaceId: string;
  value: string;
  readOnly?: boolean;
  wordWrap?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          path={path}
          // Monaco infers the language from the model path's extension.
          value={value}
          onMount={(editor) => {
            editor.focus();
          }}
          onChange={(next) => onChange(next ?? "")}
          options={{ readOnly, wordWrap: wordWrap ? "on" : "off" }}
        />
      </div>
    </div>
  );
}
