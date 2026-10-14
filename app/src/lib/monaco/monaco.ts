// Purpose: Initialize one bundled Monaco/VS Code runtime for every code surface.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TypeScriptWorker from "@codingame/monaco-vscode-standalone-typescript-language-features/worker?worker";
import TextMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";
import "@codingame/monaco-vscode-standalone-languages";
import * as typescript from "@codingame/monaco-vscode-standalone-typescript-language-features";
import { grammarsReady } from "./grammars";
import workflowTypes from "virtual:workflow-types";
import { toast } from "sonner";

/** Shared initialization; editors wait for it before creating models. This owner reports failure once for all editors. */
export const monacoReady = new MonacoVscodeApiWrapper({
  $type: "extended",
  viewsConfig: {
    $type: "EditorService",
    openEditorFunc: async () => undefined,
  },
  monacoWorkerFactory: () => {
    self.MonacoEnvironment = {
      getWorker: (_id, label) => {
        if (label === "typescript" || label === "javascript")
          return new TypeScriptWorker();
        if (label === "TextMateWorker") return new TextMateWorker();
        return new EditorWorker();
      },
    };
  },
})
  .start()
  .then(async () => {
    // The wrapper imports themes without awaiting their registration. An editor
    // mounted before this barrier silently loses its initial setTheme request.
    const themes =
      await import("@codingame/monaco-vscode-theme-defaults-default-extension");
    await Promise.all([themes.whenReady(), grammarsReady()]);
    loader.config({ monaco });
    typescript.typescriptDefaults.setCompilerOptions({
      target: typescript.ScriptTarget.ESNext,
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
      module: typescript.ModuleKind.ESNext,
      moduleResolution: typescript.ModuleResolutionKind.NodeJs,
      strict: true,
      noEmit: true,
      // `.tsx` files use the React JSX runtime.
      jsx: typescript.JsxEmit.ReactJSX,
      paths: {
        "@openchart/workflow": [workflowTypes.entry],
      },
    });
    typescript.typescriptDefaults.setExtraLibs(workflowTypes.files);
  });

void monacoReady.catch((cause: unknown) => {
  toast.error("Couldn’t start the code editor", {
    id: "code-editor-start",
    description: cause instanceof Error ? cause.message : String(cause),
  });
});
