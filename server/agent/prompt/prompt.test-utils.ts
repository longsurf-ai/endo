import { Question } from "@openchart/server/agent/question";
import { unusedModelSetup } from "@openchart/server/models/models.test-utils";
// Purpose: Shares real SQLite and controllable SDK fixtures for prompt integration tests.

import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { AvailableModel } from "@openchart/models/model-provider";
import { LLM } from "@openchart/server/agent/llm";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { PluginRegistry } from "@openchart/server/agent/plugin/registry";
import { Permission } from "@openchart/server/agent/permission";
import { AgentRun, ID } from "@openchart/server/agent/run/run";
import { Session } from "@openchart/server/agent/session";
import { ToolRegistry } from "@openchart/server/agent/tool/registry";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Models } from "@openchart/server/models";
import { Home } from "@openchart/server/home";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { Transactor, Transition } from "@openchart/server/lib/resource";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { ensureDefault } from "@openchart/server/resources/workspace/transitions/ensure-default";
import { WorkspacesLayer } from "@openchart/server/workspace/workspace";
import { ensureDefaultWorkflows } from "@openchart/server/agent/workflow/defaults";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer, type Scope } from "effect";
import { execute } from "./execute";

export const model = {
  id: "test",
  providerID: "openai",
  kind: "language" as const,
  name: "Test",
  capabilities: { input: { text: true }, output: { text: true } },
  availableVariants: ["high", "low"],
};
export const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
export const answer: LanguageModelV4StreamPart[] = [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "Done" },
  { type: "text-end", id: "text" },
  finish,
];
/** Controllable SDK and real persistence for prompt integration tests. */
export interface Fixture {
  workspace: { id: string; root: string };
  run: AgentRun;
  session: Session.Interface;
  calls: LanguageModelV4CallOptions[];
  selections: AvailableModel[];
  model: AvailableModel;
  source: () =>
    LanguageModelV4StreamPart[] | Promise<LanguageModelV4StreamPart[]>;
}

type Requirements = Effect.Services<ReturnType<typeof execute>> | Scope.Scope;

/**
 * Runs a prompt scenario against isolated SQLite and the real SDK bridge.
 * @example
 * await run(fixture => execute(fixture.run));
 */
export function run<A, E>(
  program: (fixture: Fixture) => Effect.Effect<A, E, Requirements>,
  configuration: AgentProfile.Configuration = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        const root = yield* session.create({ title: "Test" });
        yield* Transactor.run(Transition.bindInput(ensureDefault, undefined));
        yield* ensureDefaultWorkflows();
        const workspace = yield* Transactor.run(
          workspaceResource.transitions.createLocal(),
        );
        const fixture: Fixture = {
          workspace,
          session,
          calls: [],
          selections: [],
          model,
          source: () => answer,
          run: {
            id: ID.create(),
            sessionID: root.id,
            sessionIntentID: "intent",
            status: "running",
            queuePosition: null,
            createdAt: 1,
            startedAt: 1,
            finishedAt: null,
            input: {
              agent: "analyst",
              workspaceId: workspace.id,
              model: {
                providerID: "codex" as const,
                modelID: "tier1" as const,
              },
              parts: [{ type: "text", text: "Help" }],
            },
          },
        };
        const native: LanguageModelV4 = {
          specificationVersion: "v4",
          provider: model.providerID,
          modelId: model.id,
          supportedUrls: {},
          doGenerate: async () => {
            throw new Error("Unexpected generate");
          },
          doStream: async (input) => {
            fixture.calls.push(input);
            const parts = await fixture.source();
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] });
                  for (const part of parts) controller.enqueue(part);
                  controller.close();
                },
              }),
            };
          },
        };
        const service: Models.Interface = {
          ...unusedModelSetup,
          list: () => Effect.succeed([]),
          getModel: () => Effect.succeed(fixture.model),
          getLanguage: (selected) =>
            Effect.sync(() => {
              fixture.selections.push(selected);
              return native;
            }),
        };
        const models = Layer.succeed(Models.Service, service);
        return yield* program(fixture).pipe(
          Effect.scoped,
          Effect.provide(LLM.layer.pipe(Layer.provideMerge(models))),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Permission.layer,
            Question.layer,
            ToolRegistry.layer,
          ).pipe(
            Layer.provideMerge(WorkspacesLayer),
            Layer.provideMerge(Agui.layer),
            Layer.provideMerge(
              Layer.mergeAll(
                Session.layer,
                Database.layer(":memory:", () => Effect.void),
                Events.layer,
                AgentProfile.layer(configuration),
                PluginRegistry.layerDefault,
              ),
            ),
            Layer.provideMerge(
              Home.layer(temporaryHome()).pipe(
                Layer.provideMerge(NodeFileSystem.layer),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
