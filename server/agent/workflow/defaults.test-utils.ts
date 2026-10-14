// Purpose: Load shipped programs from installed files for workflow behavior tests.
import { afterEach, beforeEach } from "vitest";
import { Effect } from "effect";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime } from "@openchart/server/runtime";
import { loadWorkflow } from "./load";
import { Workflow } from "./workflow";

/** File-backed definitions for each test; closes the runtime before temporary-file cleanup. @example const load = defaultWorkflowFixture(); */
export function defaultWorkflowFixture() {
  let runtime: ReturnType<typeof makeRuntime>;
  beforeEach(async () => {
    runtime = makeRuntime({
      home: temporaryHome(),
      databasePath: ":memory:",
      models: { fetchEnabled: false, userAgent: "default-workflow-test" },
    });
    await runtime.context();
  });
  afterEach(async () => {
    await runtime.dispose();
  });
  return (reference: string) =>
    Effect.tryPromise(() =>
      runtime.runPromise(
        loadWorkflow(reference).pipe(
          Effect.map(({ definition }) => definition),
          Effect.provideService(Workflow.Service, {
            getResource: () => Effect.die("Unexpected Resource read"),
            parentPrompt: {
              agent: "analyst",
              model: { providerID: "codex", modelID: "tier4" },
              parts: [],
            },
            settings: { concurrency: 5 },
            agent: () =>
              Effect.die("Loading a workflow must not execute agents"),
          }),
        ),
      ),
    );
}
