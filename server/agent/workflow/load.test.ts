// Purpose: Exercise workspace authoring through the public file API and existing workflow tool.
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeRuntime, type Runtime } from "@openchart/server/runtime";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { router } from "@openchart/server";
import { Tool } from "@openchart/server/agent/tool/tool";
import { WorkflowTool } from "@openchart/server/agent/tool/tools/workflow";
import { WorkflowPart } from "@openchart/server/agent/contracts/part";
import { Workflow } from "./workflow";

// Real TypeScript compilation needs headroom on shared CI runners.
vi.setConfig({ testTimeout: 30_000 });

let runtime: Runtime;
let client: ReturnType<typeof router.createCaller>;
let workspace: { id: string; root: string };
const source = `import { defineWorkflow, Schema, agent, textPrompt } from "@openchart/workflow";
export default defineWorkflow({
  description: "Return a child answer",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }, { parentPrompt }) => agent(textPrompt(question, parentPrompt.model, parentPrompt.agent)),
});`;
beforeEach(async () => {
  const home = temporaryHome();
  runtime = makeRuntime({
    home,
    databasePath: ":memory:",
    models: { fetchEnabled: false, userAgent: "workflow-loader-test" },
  });
  await runtime.context();
  client = router.createCaller({ runtime });
  const root = path.join(home, "authoring");
  await mkdir(root);
  workspace = await client.resources.workspace.register({ root });
  await expect
    .poll(() => client.workspace.listTree({ workspaceId: workspace.id }), {
      timeout: 10_000,
    })
    .toMatchObject({ status: "ready" });
  expect(await readdir(root)).toEqual([]);
});
afterEach(async () => {
  await runtime.dispose();
});

async function invoke(
  reference: string,
  args: Schema.JsonObject,
  selectedWorkspace = workspace.id,
) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* WorkflowTool);
      return yield* tool
        .execute(
          { workflow: reference, args },
          {
            agent: "analyst",
            rootRunID: "agr_test",
            sessionID: "parent",
            messageID: "message",
            callID: "call",
            messages: [],
            ask: () => Effect.void,
            metadata: () => Effect.void,
          },
        )
        .pipe(
          Effect.provideService(Workflow.Service, {
            getResource: () => Effect.die("Unexpected Resource read"),
            parentPrompt: {
              agent: "analyst",
              model: {
                providerID: "codex" as const,
                modelID: "tier1" as const,
              },
              workspaceId: selectedWorkspace,
              parts: [{ type: "text", text: "Run workflow" }],
            },
            settings: { concurrency: 2 },
            agent: (input) =>
              Effect.succeed({
                sessionId: "child",
                output: input.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              }),
          }),
        );
    }),
  );
}

test("runs a standalone workflow at a unicode/space path without creating support files", async () => {
  const filename = "€ research/My Research.workflow.ts";
  await client.workspace.write({
    workspaceId: workspace.id,
    path: filename,
    text: source,
    expected: null,
  });
  const result = await invoke(`workspace:${filename}`, {
    question: "WORKSPACE_OK",
  });
  expect(result.output).toMatchObject({
    type: "json",
    value: { result: { output: "WORKSPACE_OK" } },
  });
  expect(result.metadata).toMatchObject({
    workspaceId: workspace.id,
    path: filename,
    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect((await readdir(workspace.root, { recursive: true })).sort()).toEqual([
    "€ research",
    filename,
  ]);
  expect(await readFile(path.join(workspace.root, filename), "utf8")).toBe(
    source,
  );
});

test("loads edits on the next invocation and validates args before child execution", async () => {
  const input = { workspaceId: workspace.id, path: "research.workflow.ts" };
  const entry = await client.workspace.write({
    ...input,
    text: source,
    expected: null,
  });
  await expect(
    invoke("workspace:research.workflow.ts", { question: 42 }),
  ).rejects.toThrow();
  const first = await invoke("workspace:research.workflow.ts", {
    question: "first",
  });
  await client.workspace.write({
    ...input,
    text: source.replace(
      "textPrompt(question,",
      'textPrompt("edited: " + question,',
    ),
    expected: entry.hash,
  });
  const second = await invoke("workspace:research.workflow.ts", {
    question: "second",
  });
  expect(second.output).toMatchObject({
    type: "json",
    value: { result: { output: "edited: second" } },
  });
  expect(second.metadata.hash).not.toBe(first.metadata.hash);
});

test("default references read default files while retaining the caller's workspace", async () => {
  const defaultId = await client.resources.workspace.getDefault();
  const filename = "workflows/scope.workflow.ts";
  await client.workspace.write({
    workspaceId: defaultId,
    path: filename,
    text: source.replace(
      "textPrompt(question,",
      'textPrompt(parentPrompt.workspaceId + ":default:" + question,',
    ),
    expected: null,
  });
  await client.workspace.write({
    workspaceId: workspace.id,
    path: filename,
    text: source,
    expected: null,
  });
  const result = await invoke(`default:${filename}`, { question: "scope" });
  expect(result.output).toMatchObject({
    value: { result: { output: `${workspace.id}:default:scope` } },
  });
  expect(result.metadata).toMatchObject({
    workspaceId: defaultId,
    path: filename,
  });
  expect(
    (await invoke(`workspace:${filename}`, { question: "scope" })).output,
  ).toMatchObject({
    value: { result: { output: "scope" } },
  });
  await expect(invoke("default:research.workflow.ts", {})).rejects.toThrow();
});

test.each([
  ['import "node:fs";\n' + source, "may import only"],
  [source + '\nimport("node:fs");', "static imports"],
  [source + '\nrequire("node:fs");', "static imports"],
  [
    source + '\nthrow new Error("module initialization failed");',
    "module initialization failed",
  ],
  ["export default {};", "kind"],
  ["export default defineWorkflow({", "expected"],
])("rejects invalid modules: %s", async (text, message) => {
  await client.workspace.write({
    workspaceId: workspace.id,
    path: "invalid.workflow.ts",
    text,
    expected: null,
  });
  await expect(
    invoke("workspace:invalid.workflow.ts", {}),
  ).rejects.toMatchObject({
    _tag: "Workflow.LoadFailed",
    workflow: "workspace:invalid.workflow.ts",
    message: expect.stringMatching(new RegExp(message, "i")),
  });
});

test("reports a late type error before evaluating the module or executing children", async () => {
  const text = `import { defineWorkflow, Schema, Effect, agent, textPrompt } from "@openchart/workflow";
throw new Error("Module must not be evaluated");
export default defineWorkflow({
  description: "Fail after expensive research",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }, { parentPrompt }) => Effect.gen(function* () {
    const answer = yield* agent(textPrompt(question, parentPrompt.model, parentPrompt.agent));
    return answer.output.nonexistent;
  }),
});`;
  await client.workspace.write({
    workspaceId: workspace.id,
    path: "late-error.workflow.ts",
    text,
    expected: null,
  });
  await expect(
    invoke("workspace:late-error.workflow.ts", { question: "NVDA" }),
  ).rejects.toMatchObject({
    _tag: "Workflow.LoadFailed",
    message: expect.stringMatching(
      /late-error\.workflow\.ts\(8,26\): error TS2339: Property 'nonexistent'/,
    ),
  });
});

test("rejects invalid UTF-8 when decoding workflow source", async () => {
  await writeFile(
    path.join(workspace.root, "invalid.workflow.ts"),
    Buffer.concat([Buffer.from(source + "\n// "), Buffer.from([255])]),
  );
  await expect(
    invoke("workspace:invalid.workflow.ts", {}),
  ).rejects.toMatchObject({
    _tag: "Workflow.LoadFailed",
    workflow: "workspace:invalid.workflow.ts",
    message: expect.stringMatching(/encoded data|encoding/i),
  });
});

test("rejects escaping paths, symlinks, missing files and forgotten workspaces", async () => {
  for (const reference of [
    "best-of-n@1",
    "default:../file.workflow.ts",
    "default:/file.workflow.ts",
    "default:.hidden/file.workflow.ts",
    "default:file.tea",
    "workspace:../file.workflow.ts",
    "workspace:/file.workflow.ts",
    "workspace:.hidden/file.workflow.ts",
    "workspace:file.tea",
  ]) {
    expect(() =>
      Schema.decodeUnknownSync(WorkflowPart.fields.workflow)(reference),
    ).toThrow();
  }
  await expect(invoke("workspace:missing.workflow.ts", {})).rejects.toThrow();
  const outside = path.join(temporaryHome(), "outside.workflow.ts");
  await writeFile(outside, source);
  await symlink(outside, path.join(workspace.root, "linked.workflow.ts"));
  await expect(invoke("workspace:linked.workflow.ts", {})).rejects.toThrow();
  await client.resources.workspace.forget({ id: workspace.id });
  await expect(invoke("workspace:linked.workflow.ts", {})).rejects.toThrow();
});

test("acquires and runs a read-only workspace without changing its files or dependencies", async () => {
  const root = path.join(temporaryHome(), "existing-project");
  const files = {
    "research.workflow.ts": source,
    "package.json": '{"name":"user-project"}',
    "tsconfig.json": '{"compilerOptions":{"noEmit":true}}',
    "node_modules/@openchart/workflow/package.json": '{"name":"user-owned"}',
    "node_modules/@openchart/workflow/index.js":
      'throw new Error("Do not load the workspace package");',
  };
  for (const [filename, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), text);
  }
  const before = (await readdir(root, { recursive: true })).sort();
  const directories = [
    root,
    path.join(root, "node_modules"),
    path.join(root, "node_modules/@openchart"),
    path.join(root, "node_modules/@openchart/workflow"),
  ];
  try {
    for (const directory of directories) await chmod(directory, 0o555);
    for (const filename of Object.keys(files))
      await chmod(path.join(root, filename), 0o444);
    const registered = await client.resources.workspace.register({ root });
    await expect
      .poll(() => client.workspace.listTree({ workspaceId: registered.id }), {
        timeout: 10_000,
      })
      .toMatchObject({
        status: "ready",
        entries: expect.arrayContaining([{ path: "research.workflow.ts" }]),
      });
    const result = await invoke(
      "workspace:research.workflow.ts",
      { question: "READ_ONLY_OK" },
      registered.id,
    );
    expect(result.output).toMatchObject({
      type: "json",
      value: { result: { output: "READ_ONLY_OK" } },
    });
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
    for (const [filename, text] of Object.entries(files))
      expect(await readFile(path.join(root, filename), "utf8")).toBe(text);
  } finally {
    for (const directory of directories) await chmod(directory, 0o755);
    for (const filename of Object.keys(files))
      await chmod(path.join(root, filename), 0o644);
  }
});
