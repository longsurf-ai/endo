// Purpose: Exercise bundled SDK types with Monaco's actual TypeScript worker.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
const workerEntry = import.meta
  .resolve("@codingame/monaco-vscode-standalone-typescript-language-features/worker");
const { TypeScriptWorker } = await import(
  new URL("./tsWorker.js", workerEntry)
);
const { typescript } = await import(
  new URL("./lib/typescriptServices.js", workerEntry)
);

const { ScriptTarget, ModuleKind, ModuleResolutionKind } = typescript;

let server;
let declarations;
const fileUri = "inmemory:///editor/workspace/research.workflow.ts";

before(async () => {
  server = await createServer({
    configFile: new URL("../../vite.config.ts", import.meta.url).pathname,
    server: { middlewareMode: true },
    logLevel: "error",
  });
  declarations = (await server.ssrLoadModule("virtual:workflow-types")).default;
});
after(async () => server?.close());

function worker(source) {
  return new TypeScriptWorker(
    { getMirrorModels: () => [] },
    {
      compilerOptions: {
        target: ScriptTarget.ESNext,
        lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
        module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.NodeJs,
        strict: true,
        noEmit: true,
        paths: { "@openchart/workflow": [declarations.entry] },
      },
      extraLibs: {
        ...Object.fromEntries(
          declarations.files.map(({ filePath, content }) => [
            filePath,
            { content, version: 1 },
          ]),
        ),
        [fileUri]: { content: source, version: 1 },
      },
    },
  );
}

const source = `
import { agent, defineWorkflow, Effect, parallel, Schema, textPrompt, CODEX, TIER4 } from "@openchart/workflow";
export default defineWorkflow({
  description: "Research",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }, { parentPrompt }) => Effect.gen(function* () {
    const answers = yield* parallel([
      agent(textPrompt(question, { providerID: CODEX, modelID: TIER4 }, parentPrompt.agent)),
    ]);
    return answers;
  }),
});`;

test("valid workflows resolve the SDK and its complete declaration dependencies", async () => {
  const service = worker(source);
  assert.deepEqual(await service.getSyntacticDiagnostics(fileUri), []);
  assert.deepEqual(await service.getSemanticDiagnostics(fileUri), []);
  const diagnostics = (
    await Promise.all(
      declarations.files.map(({ filePath }) =>
        service.getSemanticDiagnostics(filePath),
      ),
    )
  ).flat();
  assert.deepEqual(
    diagnostics
      .map(({ messageText, code }) => ({ messageText, code }))
      .slice(0, 12),
    [],
  );
});

test("schema-inferred arguments retain type errors", async () => {
  const service = worker(
    source.replace("textPrompt(question,", "textPrompt(question * 2,"),
  );
  const diagnostics = await service.getSemanticDiagnostics(fileUri);
  assert.ok(diagnostics.some(({ code }) => code === 2362));
  assert.ok(diagnostics.some(({ code }) => code === 2345));
});

test("completes SDK exports, Schema members and inferred string arguments", async () => {
  for (const [text, position, expected] of [
    ['import {  } from "@openchart/workflow";', 9, "defineWorkflow"],
    [
      'import { Schema } from "@openchart/workflow"; Schema.',
      undefined,
      "Struct",
    ],
    [
      source.replace("return answers;", "question.\nreturn answers;"),
      source.indexOf("return answers;") + "question.".length,
      "toUpperCase",
    ],
  ]) {
    const completion = await worker(text).getCompletionsAtPosition(
      fileUri,
      position ?? text.length,
    );
    assert.ok(
      completion?.entries.some(({ name }) => name === expected),
      expected,
    );
  }
});
