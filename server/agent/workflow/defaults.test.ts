// Purpose: Default programs are ordinary editable files installed without replacing user bytes.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { router } from "@openchart/server";
import { makeRuntime } from "@openchart/server/runtime";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { ensureDefaultWorkflows } from "./defaults";
import { loadWorkflow } from "./load";
import { Workflow } from "./workflow";

const runtimes: ReturnType<typeof makeRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

// Starts the runtime twice and type-checks every shipped workflow.
test("seeds every shipped file, preserves edits on restart, and backfills missing defaults", async () => {
  const home = temporaryHome();
  const directory = path.join(home, "workspaces/default/workflows");
  const edited = `import { defineWorkflow, Schema, Effect } from "@openchart/workflow";
export default defineWorkflow({description: "Edited", args: Schema.Struct({}), run: () => Effect.succeed("edited")});`;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "best-of-n.workflow.ts"), edited);
  const start = async () => {
    const runtime = makeRuntime({
      home,
      models: { fetchEnabled: false, userAgent: "workflow-seed-test" },
    });
    runtimes.push(runtime);
    await runtime.context();
    return { runtime, rpc: router.createCaller({ runtime }) };
  };
  const first = await start();
  const files = (await readdir(new URL("./templates/", import.meta.url)))
    .filter((file) => file.endsWith(".workflow.ts"))
    .sort();
  expect(files).toContain("thesis-killer.workflow.ts");
  expect((await readdir(directory)).sort()).toEqual(files);
  expect(
    await readFile(path.join(directory, "best-of-n.workflow.ts"), "utf8"),
  ).toBe(edited);
  const workspaceId = await first.rpc.resources.workspace.getDefault();
  for (const file of files) {
    const loaded = await first.runtime.runPromise(
      loadWorkflow(`default:workflows/${file}`).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt: {
            agent: "analyst",
            model: { providerID: "codex", modelID: "tier4" },
            parts: [],
          },
          settings: { concurrency: 5 },
          agent: () => Effect.die("Loading must not execute agents"),
        }),
      ),
    );
    expect(loaded.definition.kind).toBe("workflow");
    expect(loaded.metadata).toMatchObject({
      workspaceId,
      path: `workflows/${file}`,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  }
  const original = await first.rpc.workspace.read({
    workspaceId,
    path: "workflows/best-of-n.workflow.ts",
  });
  expect(original.readOnly).toBe(false);
  const changed = edited.replace('"edited"', '"saved"');
  await first.rpc.workspace.write({
    workspaceId,
    path: original.entry.path,
    text: changed,
    expected: original.entry.hash,
  });
  await first.runtime.runPromise(ensureDefaultWorkflows());
  expect(
    await readFile(path.join(directory, "best-of-n.workflow.ts"), "utf8"),
  ).toBe(changed);
  await rm(path.join(directory, "hypothesis-race.workflow.ts"));
  await first.runtime.dispose();
  runtimes.splice(runtimes.indexOf(first.runtime), 1);
  await start();
  expect((await readdir(directory)).sort()).toEqual(files);
  expect(
    await readFile(path.join(directory, "best-of-n.workflow.ts"), "utf8"),
  ).toBe(changed);
}, 30_000);
