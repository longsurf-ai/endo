// Purpose: Type-check and emit one source snapshot against the bundled workflow SDK.
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Checks a trusted workspace module before emitting its CommonJS code in memory.
 * Uses only host-owned SDK declarations and compiler settings, never workspace
 * configuration or installed types. Throws diagnostics with file/line/column;
 * the loader maps them to Workflow.LoadFailed before evaluating any source.
 * @example const javascript = compileWorkflow(source, "/workspace/research.workflow.ts");
 */
export function compileWorkflow(text: string, filename: string): string {
  const declarations = fileURLToPath(
    new URL("./.artifacts/workflow-types/workflow.d.ts", import.meta.url),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    ignoreDeprecations: "6.0",
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    skipLibCheck: true,
    noEmitOnError: true,
    inlineSourceMap: true,
    inlineSources: true,
  };
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  inspectImports(source);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, ...args) =>
    file === filename ? source : getSourceFile(file, ...args);
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) =>
      containingFile === filename
        ? name === "@openchart/workflow"
          ? { resolvedFileName: declarations, extension: ts.Extension.Dts }
          : undefined
        : ts.resolveModuleName(name, containingFile, options, host)
            .resolvedModule,
    );
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(ts.formatDiagnostics(diagnostics, host));
  let javascript: string | undefined;
  const emitted = program.emit(source, (file, content) => {
    if (file.endsWith(".js")) javascript = content;
  });
  if (emitted.emitSkipped || javascript === undefined)
    throw new Error(
      ts.formatDiagnostics(emitted.diagnostics, host) ||
        "Workflow compilation produced no JavaScript",
    );
  return javascript;
}

function inspectImports(source: ts.SourceFile) {
  if (source.referencedFiles.length || source.typeReferenceDirectives.length)
    throw new Error(
      "Workflow files may reference only the bundled @openchart/workflow types",
    );
  const inspect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        (!ts.isStringLiteral(node.moduleSpecifier) ||
          node.moduleSpecifier.text !== "@openchart/workflow")
      )
        throw new Error("Workflow files may import only @openchart/workflow");
    }
    if (
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")))
    )
      throw new Error("Use static imports from @openchart/workflow");
    ts.forEachChild(node, inspect);
  };
  inspect(source);
}
