// Purpose: Opt-in tier-1 native-provider smoke through persisted workspace workflow execution.

import { symlinkSync } from "node:fs";
import path from "node:path";
import { CODEX, CLAUDE_CODE, TIER1 } from "@openchart/models/model-tiers";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Session } from "@openchart/server/agent/session";
import { SessionRunner } from "@openchart/server/agent/session/runner";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { Transactor } from "@openchart/server/lib/resource";
import { Models } from "@openchart/server/models";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { makeRuntime } from "@openchart/server/runtime";
import { assertExists } from "@openchart/utils/assert";
import { Effect, FileSystem, Schema } from "effect";
import { expect, test } from "vitest";

// Use an existing app-managed runtime directory; default checks make no model calls.
const runtimes = process.env.OPENCHART_WORKFLOW_RUNTIME_DIR;

test.runIf(Boolean(runtimes)).each([CODEX, CLAUDE_CODE])(
  "%s tier 1 drives a structured loop and reads its automatically referenced transcript",
  async (providerID) => {
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
          const models = yield* Models.Service;
          const selected = yield* models.getModel(providerID, TIER1);
          expect(selected.tier).toBe(1);
          const workspace = yield* Transactor.run(
            workspaceResource.transitions.createLocal(),
          );
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            path.join(workspace.root, "structured.workflow.ts"),
            `
import { agent, defineWorkflow, Effect, Schema, textPrompt, phase } from "@openchart/workflow";
export default defineWorkflow({
  description: "Check native structured outputs with a bounded loop",
  args: Schema.Struct({}),
  run: (_, {parentPrompt}) => Effect.gen(function* () {
    const Review = Schema.Struct({round: Schema.FiniteFromString, passed: Schema.Boolean});
    let result;
    let calls = 0;
    for (let round = 1; round <= 3; round++) {
      result = yield* phase("Round " + round, agent(textPrompt(
        "Return round as the string containing " + round + " and passed=" + (round >= 2) + ". This is a format test; use no tools.",
        parentPrompt.model, parentPrompt.agent,
      ), {schema: Review, sessionId: result?.sessionId}));
      calls++;
      if (result.output.passed) break;
    }
    const final = yield* phase("Text continuation", agent(textPrompt(
      "Now reply with only the plain text STRUCTURED_OK. Use no tools.",
      parentPrompt.model, parentPrompt.agent,
    ), {sessionId: result.sessionId}));
    return {calls, result: result.output, final: final.output};
  }),
});
`,
          );
          const session = yield* Session.Service;
          const root = yield* session.create({
            title: "Structured output live smoke",
          });
          const runs = yield* AgentRunStore.Service;
          const runner = yield* SessionRunner.Service;
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "structured-live",
            input: {
              agent: "analyst",
              workspaceId: workspace.id,
              model: { providerID, modelID: TIER1 },
              parts: [
                {
                  type: "workflow",
                  workflow: "workspace:structured.workflow.ts",
                  args: {},
                },
                {
                  type: "text",
                  text: "After the workflow finishes, inspect its child transcript with read_transcript using the automatically supplied childSessionIds. Then reply only with the child's last assistant text. Do not repeat the workflow or use any other tools.",
                },
              ],
            },
          });
          yield* runner.run({ sessionID: root.id });
          expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
          const { history } = yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: 10,
          });
          const tool = history
            .flatMap(({ parts }) => parts)
            .find((part) => part.type === "tool");
          expect(tool?.state).toMatchObject({ status: "completed" });
          if (
            tool?.state.status !== "completed" ||
            tool.state.output.type !== "json"
          )
            return yield* Effect.die("The workflow did not return JSON");
          const trace = Schema.decodeUnknownSync(
            Schema.Struct({
              resourceSpans: Schema.Array(
                Schema.Struct({
                  scopeSpans: Schema.Array(
                    Schema.Struct({
                      spans: Schema.Array(
                        Schema.Struct({
                          name: Schema.String,
                          endTimeUnixNano: Schema.String,
                        }),
                      ),
                    }),
                  ),
                }),
              ),
            }),
          )(tool.state.metadata?.trace);
          const phaseSpans = trace.resourceSpans
            .flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
            .filter((s) => s.name === "Workflow.phase");
          expect(phaseSpans).toHaveLength(3);
          expect(phaseSpans.every((s) => BigInt(s.endTimeUnixNano) > 0n)).toBe(
            true,
          );
          const value = Schema.decodeUnknownSync(
            Schema.Struct({
              childSessionIds: Schema.Array(Schema.String),
              result: Schema.Struct({
                calls: Schema.Number,
                result: Schema.Struct({
                  round: Schema.Number,
                  passed: Schema.Boolean,
                }),
                final: Schema.String,
              }),
            }),
          )(tool.state.output.value);
          expect(value.result.calls).toBe(2);
          expect(value.result.result).toEqual({ round: 2, passed: true });
          expect(value.result.final).toBe("STRUCTURED_OK");
          expect(value.childSessionIds).toHaveLength(1);
          expect(value.childSessionIds).toEqual(tool.childSessionIds);
          const reads = history
            .flatMap(({ parts }) => parts)
            .filter(
              (part) => part.type === "tool" && part.tool === "read_transcript",
            );
          expect(reads.length).toBeGreaterThan(0);
          for (const read of reads) {
            expect(read).toMatchObject({
              state: {
                status: "completed",
                input: { session_id: value.childSessionIds[0] },
              },
            });
          }
          expect(
            history
              .at(-1)!
              .parts.filter((part) => part.type === "text")
              .at(-1)?.text,
          ).toBe("STRUCTURED_OK");
          const child = yield* session.readTranscriptPage({
            sessionID: value.childSessionIds[0]!,
            turnLimit: 10,
          });
          const replies = child.history.filter(
            ({ info }) => info.role === "assistant",
          );
          expect(replies).toHaveLength(3);
          for (const { info } of replies)
            expect(info).toMatchObject({ providerID, modelID: selected.id });
          return {
            providerID,
            model: selected.id,
            calls: value.result.calls,
            output: value.result.result,
            final: value.result.final,
            transcriptReads: reads.length,
          };
        }).pipe(Effect.timeout("3 minutes")),
      );
      console.info("Structured workflow live smoke", report);
    } finally {
      await runtime.dispose();
    }
  },
  210_000,
);
