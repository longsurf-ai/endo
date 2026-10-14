// Purpose: Prove snapshot checking, host-owned types, and relocated compiler assets.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { expect, test } from "vitest";
import { compileWorkflow } from "./compile-workflow";

const source = `import { defineWorkflow, Schema, Effect } from "@openchart/workflow";
export default defineWorkflow({
  description: "Typed input",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }) => Effect.succeed(question.toUpperCase()),
});`;

test("checks the supplied snapshot with SDK types despite workspace files and config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-source-"));
  try {
    const filename = path.join(directory, "research.workflow.ts");
    await writeFile(filename, "This is not the supplied source snapshot!");
    await writeFile(
      path.join(directory, "tsconfig.json"),
      '{"compilerOptions":{"strict":false,"noCheck":true}}',
    );
    const fakeSdk = path.join(directory, "node_modules/@openchart/workflow");
    await mkdir(fakeSdk, { recursive: true });
    await writeFile(
      path.join(fakeSdk, "index.d.ts"),
      "export const defineWorkflow: any; export const Schema: any; export const Effect: any;",
    );
    expect(compileWorkflow(source, filename)).toContain(
      "question.toUpperCase()",
    );
    expect(() =>
      compileWorkflow(source.replace("toUpperCase()", "toFixed(2)"), filename),
    ).toThrow(/research\.workflow\.ts\(5,50\): error TS2551/);
    expect(await readFile(filename, "utf8")).toBe(
      "This is not the supplied source snapshot!",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checks and emits after relocation with only SDK declarations and TypeScript installed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-compiler-"));
  try {
    await cp(
      new URL("./.artifacts/workflow-types/", import.meta.url),
      path.join(directory, ".artifacts/workflow-types"),
      { recursive: true },
    );
    const typescriptRoot = path.dirname(
      path.dirname(ts.getDefaultLibFilePath({})),
    );
    await cp(typescriptRoot, path.join(directory, "node_modules/typescript"), {
      recursive: true,
    });
    const compiler = await readFile(
      new URL("./compile-workflow.ts", import.meta.url),
      "utf8",
    );
    await writeFile(
      path.join(directory, "compile-workflow.mjs"),
      ts.transpileModule(compiler, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    );
    await writeFile(
      path.join(directory, "smoke.mjs"),
      `
import assert from "node:assert/strict";
import { compileWorkflow } from "./compile-workflow.mjs";
const source = ${JSON.stringify(source)};
assert.match(compileWorkflow(source, "/workspace/research.workflow.ts"), /question.toUpperCase/);
assert.throws(() => compileWorkflow(source.replace("toUpperCase()", "toFixed(2)"), "/workspace/research.workflow.ts"), /TS2551/);
console.log("RELOCATED_WORKFLOW_TYPES_OK");
`,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["smoke.mjs"],
      {
        cwd: directory,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
        timeout: 30_000,
      },
    );
    expect(stdout).toContain("RELOCATED_WORKFLOW_TYPES_OK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
