// Purpose: Verifies native roots see a completed deterministic workflow, including on existing Sessions.
import { randomUUID } from "node:crypto";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { CLAUDE_CODE, CODEX, TIER1 } from "@openchart/models/model-tiers";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Session } from "@openchart/server/agent/session";
import { SessionRunner } from "@openchart/server/agent/session/runner";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { Transactor } from "@openchart/server/lib/resource";
import { Models } from "@openchart/server/models";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { makeRuntime } from "@openchart/server/runtime";
import { assertExists } from "@openchart/utils/assert";
import { Effect, FileSystem } from "effect";
import { expect, test } from "vitest";

const runtimes = process.env.OPENCHART_WORKFLOW_RUNTIME_DIR;
const cases = [CODEX, CLAUDE_CODE].flatMap((providerID) =>
  [false, true].map((priorTurn) => ({ providerID, priorTurn })),
);

test.runIf(Boolean(runtimes)).each(cases)(
  "$providerID consumes a workflow exactly once (prior turn: $priorTurn)",
  async ({ providerID, priorTurn }) => {
    assertExists(runtimes, "Opt-in smoke requires installed native runtimes");
    const home = temporaryHome();
    symlinkSync(path.resolve(runtimes), path.join(home, "model-providers"));
    const runtime = makeRuntime({
      home,
      databasePath: ":memory:",
      models: { fetchEnabled: false },
    });
    try {
      const report = await runtime.runPromise(
        Effect.gen(function* () {
          const selected = yield* (yield* Models.Service).getModel(
            providerID,
            TIER1,
          );
          const workspace = yield* Transactor.run(
            workspaceResource.transitions.createLocal(),
          );
          // Only the completed tool result contains the chosen option. Neither the
          // original user message nor an earlier native Session can supply it.
          const chosen = `OPTION_${randomUUID()}`;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            path.join(workspace.root, "completion.workflow.ts"),
            `
import { defineWorkflow, Effect, Schema, phase } from "@openchart/workflow";
export default defineWorkflow({
  description: "Choose an option and return its final summary",
  args: Schema.Struct({ topic: Schema.String, round: Schema.Int }),
  run: (args) => phase("Choose", Effect.succeed({
    ...args,
    detail: "x".repeat(5000),
    summary: { output: "The chosen option is ${chosen}." },
  })),
});
`,
          );
          const session = yield* Session.Service;
          const root = yield* session.create({
            title: "Workflow completion live smoke",
          });
          const runs = yield* AgentRunStore.Service;
          const runner = yield* SessionRunner.Service;
          const input = {
            agent: "analyst",
            workspaceId: workspace.id,
            model: { providerID, modelID: TIER1 },
          };
          if (priorTurn) {
            yield* runs.enqueue({
              sessionID: root.id,
              sessionIntentID: "prelude",
              input: {
                ...input,
                parts: [
                  { type: "text", text: "Reply only READY. Do not use tools." },
                ],
              },
            });
            yield* runner.run({ sessionID: root.id });
          }
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "workflow",
            input: {
              ...input,
              parts: [
                {
                  type: "workflow",
                  workflow: "workspace:completion.workflow.ts",
                  args: { topic: "Choose a test option", round: 2 },
                },
              ],
            },
          });
          yield* runner.run({ sessionID: root.id });
          const read = () =>
            session.readTranscriptPage({ sessionID: root.id, turnLimit: 10 });
          const { history } = yield* read();
          const tools = history
            .flatMap(({ parts }) => parts)
            .filter((part) => part.type === "tool");
          expect(tools).toHaveLength(1);
          expect(tools[0]).toMatchObject({
            tool: "workflow",
            state: {
              status: "completed",
              metadata: {
                preparedArgs: { topic: "Choose a test option", round: 2 },
              },
            },
          });
          const reply = history.at(-1)!;
          expect(reply.info).toMatchObject({
            role: "assistant",
            providerID,
            modelID: selected.id,
          });
          const final = reply.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          expect(final).toContain(chosen);

          // A later turn must not resume a stale native conversation that never
          // received the workflow's result or the root's answer.
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "follow-up",
            input: {
              ...input,
              parts: [
                {
                  type: "text",
                  text: "What was the chosen option from the completed workflow? Reply only with that exact option. Do not use tools.",
                },
              ],
            },
          });
          yield* runner.run({ sessionID: root.id });
          const followUp = (yield* read()).history;
          expect(
            followUp
              .at(-1)!
              .parts.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          ).toContain(chosen);
          expect(
            followUp
              .flatMap(({ parts }) => parts)
              .filter((part) => part.type === "tool"),
          ).toHaveLength(1);
          expect(
            (yield* runs.list(root.id)).every(
              (run) => run.status === "completed",
            ),
          ).toBe(true);
          return {
            providerID,
            model: selected.id,
            priorTurn,
            workflowCalls: tools.length,
            final,
          };
        }).pipe(Effect.timeout("3 minutes")),
      );
      console.info("Workflow completion live smoke", report);
    } finally {
      await runtime.dispose();
    }
  },
  210_000,
);
