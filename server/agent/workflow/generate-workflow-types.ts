// Purpose: Generate the host-owned SDK declarations shared by execution and Monaco.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

/**
 * Bundles the real authoring API and its declaration dependencies at build time.
 * Module boundaries preserve Effect's types; no server implementation is emitted.
 * The caller owns output placement and watch-file registration.
 * @example const { files } = await generateWorkflowTypes();
 */
export async function generateWorkflowTypes() {
  const bundle = await rollup({
    input: {
      workflow: fileURLToPath(new URL("./authoring/index.ts", import.meta.url)),
    },
    plugins: [
      dts({
        tsconfig: fileURLToPath(
          new URL("../../../tsconfig.json", import.meta.url),
        ),
        respectExternal: true,
        compilerOptions: { incremental: false, preserveSymlinks: false },
      }),
    ],
  });
  try {
    const { output } = await bundle.generate({
      format: "es",
      preserveModules: true,
      entryFileNames: "[name].d.ts",
    });
    return {
      watchFiles: bundle.watchFiles,
      entry: "workflow.d.ts",
      files: output.map((chunk) => {
        if (chunk.type !== "chunk")
          throw new Error("Unexpected workflow declaration asset");
        return { fileName: chunk.fileName, content: chunk.code };
      }),
    };
  } finally {
    await bundle.close();
  }
}

/**
 * Prepares declarations beside source modules for tests and the source-run demo.
 * Desktop emits the same files beside its backend bundle instead.
 * @example await writeWorkflowTypes();
 */
export default async function writeWorkflowTypes() {
  const directory = fileURLToPath(
    new URL("./.artifacts/workflow-types/", import.meta.url),
  );
  const { files } = await generateWorkflowTypes();
  await Promise.all(
    files.map(async ({ fileName, content }) => {
      const target = join(directory, fileName);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }),
  );
}
