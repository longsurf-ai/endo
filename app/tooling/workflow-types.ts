// Purpose: Supply the host-owned workflow declarations to the lazy Monaco editor.
import { generateWorkflowTypes } from "@openchart/server/agent/workflow/generate-workflow-types";
import type { Plugin } from "vite";

const moduleId = "virtual:workflow-types";
const resolvedId = `\0${moduleId}`;

/**
 * Supplies SDK declarations as text; no server code executes in the renderer.
 * Vite owns caching and invalidation, and no files are emitted into user workspaces.
 * @example plugins: [workflowTypes()]
 */
export function workflowTypes(): Plugin {
  return {
    name: "workflow-types",
    resolveId: (id) => (id === moduleId ? resolvedId : undefined),
    async load(id) {
      if (id !== resolvedId) return;
      const { entry, files, watchFiles } = await generateWorkflowTypes();
      for (const file of watchFiles) this.addWatchFile(file);
      const uri = (file: string) => `file:///workflow-types/${file}`;
      return `export default ${JSON.stringify({
        entry: uri(entry),
        files: files.map(({ fileName, content }) => ({
          filePath: uri(fileName),
          content,
        })),
      })};`;
    },
  };
}
