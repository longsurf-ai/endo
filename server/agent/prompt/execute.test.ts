// Purpose: Exercises prompt policy and tool context through real SQLite, Processor, and SDK requests.

import { CLAUDE_CODE, CODEX, TIER4 } from "@openchart/models/model-tiers";

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import type { EvidenceCandidate } from "@openchart/server/agent/contracts/part";
import { SessionId } from "@openchart/server/agent/contracts/session";
import type { ClaudeCodeProviderOptions } from "@openchart/models/providers/claude-code/adapter/index";
import type { CodexProviderOptions } from "@openchart/models/providers/codex/adapter/index";
import { Permission } from "@openchart/server/agent/permission";
import { ToolRegistry } from "@openchart/server/agent/tool/registry";
import { Tool } from "@openchart/server/agent/tool/tool";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { Database } from "@openchart/server/db";
import { Home } from "@openchart/server/home";
import path from "node:path";
import { assertExists } from "@openchart/utils/assert";
import { ConfigProvider, Effect, Exit, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { isUsableSummary, readHistory } from "./history";
import { execute } from "./execute";
import { run, model, finish, answer } from "./prompt.test-utils";

const candidate: EvidenceCandidate = {
  source: {
    kind: "web_search_result",
    title: "Source",
    url: "https://example.com/source",
    hostname: "example.com",
  },
  blocks: [{ kind: "excerpt", text: "Exact evidence" }],
};

test("manual compaction preserves accompanying context, stops, and reuses the summary on the next prompt", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      yield* execute(fixture.run);
      const viewContext = "Current workspace file: notes.md";
      const parts: AgentPromptInput["parts"] = [
        { type: "compaction", auto: false },
        { type: "text", text: viewContext, synthetic: true },
      ];
      fixture.run.input.parts = parts;
      yield* execute(fixture.run);
      const { history } = yield* fixture.session.readTranscriptPage({
        sessionID: fixture.run.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(history).toHaveLength(4);
      const marker = history[2]!;
      const summary = history[3]!;
      expect(marker.parts).toMatchObject(parts);
      expect(isUsableSummary(summary)).toBe(true);
      expect(summary.info).toMatchObject({
        triggeringUserMessageID: marker.info.id,
      });
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.calls[1]?.tools ?? []).toEqual([]);
      expect(JSON.stringify(fixture.calls[1]?.prompt)).toContain(viewContext);
      expect(
        (yield* readHistory(fixture.run.sessionID)).map(({ info }) => info.id),
      ).toEqual([marker.info.id, summary.info.id]);
      fixture.run.input.parts = [
        { type: "text", text: "Continue after compaction" },
      ];
      yield* execute(fixture.run);
      expect(fixture.calls).toHaveLength(3);
      expect(JSON.stringify(fixture.calls[2]?.prompt)).toContain(
        "Continue after compaction",
      );
      expect(JSON.stringify(fixture.calls[2]?.prompt)).not.toContain('"Help"');
      expect(JSON.stringify(fixture.calls[2]?.prompt)).toContain(viewContext);
    }),
  );
});

test("a failed manual compaction preserves context and is not repeated by the next prompt", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      yield* execute(fixture.run);
      fixture.run.input.parts = [{ type: "compaction", auto: false }];
      fixture.source = () => [finish];
      expect(
        Exit.isFailure(yield* execute(fixture.run).pipe(Effect.exit)),
      ).toBe(true);
      const history = yield* readHistory(fixture.run.sessionID);
      expect(history[0]?.parts).toMatchObject([{ text: "Help" }]);
      expect(history.some(isUsableSummary)).toBe(false);
      fixture.source = () => answer;
      fixture.run.input.parts = [{ type: "text", text: "Try another task" }];
      yield* execute(fixture.run);
      expect(fixture.calls).toHaveLength(3);
      expect(JSON.stringify(fixture.calls[2]?.prompt)).toContain('"Help"');
      const all = yield* fixture.session.readTranscriptPage({
        sessionID: fixture.run.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(
        all.history.filter(({ parts }) =>
          parts.some((part) => part.type === "compaction"),
        ),
      ).toHaveLength(1);
    }),
  );
});

test.each([TIER4])(
  "keeps the resolved native model across steps for %s input",
  async (modelID) => {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.run.input.model.modelID = modelID;
        fixture.source = () => {
          fixture.model = { ...model, id: "newly-discovered-model" };
          return fixture.calls.length === 1
            ? [
                {
                  ...finish,
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ]
            : answer;
        };
        yield* execute(fixture.run);
        expect(fixture.selections.map(({ id }) => id)).toEqual([
          model.id,
          model.id,
        ]);
        const { history } = yield* fixture.session.readTranscriptPage({
          sessionID: fixture.run.sessionID,
          turnLimit: Number.MAX_SAFE_INTEGER,
        });
        expect(history[0]?.info).toMatchObject({ model: { modelID } });
        expect(
          history
            .slice(1)
            .map(({ info }) => info.role === "assistant" && info.modelID),
        ).toEqual([model.id, model.id]);
        expect(fixture.run.input.model.modelID).toBe(modelID);
      }),
    );
  },
);

test("preserves an omitted workspace through prompt execution and User persistence", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      delete fixture.run.input.workspaceId;
      yield* execute(fixture.run);

      const { history } = yield* fixture.session.readTranscriptPage({
        sessionID: fixture.run.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(history[0]?.info.role).toBe("user");
      expect(history[0]?.info).not.toHaveProperty("workspaceId");
      expect(fixture.run.input).not.toHaveProperty("workspaceId");
      expect(fixture.calls).toHaveLength(1);
      const home = yield* Home;
      expect(history[1]?.info).toMatchObject({
        path: {
          cwd: path.join(home.root, "workspaces", "default"),
          root: path.join(home.root, "workspaces", "default"),
        },
      });
    }),
  );
});

test("rejects an unknown workspace before persisting input or calling a provider", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.run.input.workspaceId = "wsp_unknown";
      const error = yield* execute(fixture.run).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "Resource.NotFound" });
      expect(fixture.calls).toHaveLength(0);
      expect(
        (yield* fixture.session.readTranscriptPage({
          sessionID: fixture.run.sessionID,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history,
      ).toEqual([]);
    }),
  );
});

test("continues tool-call finishes, applies step reminders, and preserves explicit model variants", async () => {
  await run(
    (fixture) =>
      Effect.gen(function* () {
        fixture.model = { ...model, providerID: CODEX };
        fixture.run.input.model.selectedVariant = "low";
        fixture.source = () =>
          fixture.calls.length === 1
            ? [
                {
                  ...finish,
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ]
            : answer;
        yield* execute(fixture.run);
        const transcript = yield* fixture.session.listMessages({
          sessionID: fixture.run.sessionID,
          limit: 100,
        });
        expect(transcript.items).toHaveLength(3);
        expect(transcript.items[0]?.info).toMatchObject({
          model: { selectedVariant: "low" },
          workspaceId: fixture.workspace.id,
        });
        expect(
          transcript.items
            .slice(1)
            .every(
              (message) =>
                message.info.role === "assistant" &&
                message.info.path.cwd === fixture.workspace.root,
            ),
        ).toBe(true);
        expect(fixture.calls).toHaveLength(2);
        for (const call of fixture.calls) {
          expect(call.providerOptions?.["codex-app-server"]).toMatchObject({
            effort: "low",
          });
        }
        expect(JSON.stringify(fixture.calls[1]?.prompt)).toContain(
          "MAXIMUM STEPS REACHED",
        );
        expect(
          transcript.items.flatMap((message) => message.parts),
        ).not.toContainEqual(
          expect.objectContaining({
            text: expect.stringContaining("MAXIMUM STEPS REACHED"),
          }),
        );
      }),
    {
      agents: {
        analyst: {
          model: { providerID: "codex" as const, modelID: "tier1" as const },
          selectedVariant: "high",
          steps: 2,
        },
      },
    },
  );
});

test("executes automatic compaction before resuming with freshly committed history", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.model = { ...model, limit: { context: 2000, output: 1000 } };
      fixture.run.input.parts = [
        { type: "text", text: "Original research context. ".repeat(500) },
      ];
      fixture.source = () => {
        if (fixture.calls.length === 1)
          return [
            {
              ...finish,
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ];
        if (fixture.calls.length === 2)
          return [
            { type: "text-start", id: "summary" },
            {
              type: "text-delta",
              id: "summary",
              delta: "Compacted research summary",
            },
            { type: "text-end", id: "summary" },
            finish,
          ];
        return answer;
      };

      yield* execute(fixture.run);

      expect(fixture.calls).toHaveLength(3);
      expect(JSON.stringify(fixture.calls[1]?.prompt)).toContain(
        "Provide a detailed prompt for continuing our conversation above",
      );
      const replay = JSON.stringify(fixture.calls[2]?.prompt);
      expect(replay).toContain("Compacted research summary");
      expect(replay).toContain("Continue if you have next steps");
      expect(replay).not.toContain("Original research context");
      const transcript = yield* fixture.session.listMessages({
        sessionID: fixture.run.sessionID,
        limit: 100,
      });
      expect(transcript.items).toHaveLength(6);
      expect(
        transcript.items.filter(
          (message) =>
            message.info.role === "assistant" && message.info.summary,
        ),
      ).toHaveLength(1);
      expect(transcript.items.at(-1)?.info).toMatchObject({
        role: "assistant",
        agent: "analyst",
        finish: "stop",
      });
    }),
  );
});

test("clips oversized native tool results into stable replay prefixes without rewriting stored history", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.model = {
        ...model,
        limit: { context: 1_000_000, output: 32_000 },
      };
      const payload = "x".repeat(300_000);
      fixture.source = () => {
        if (fixture.calls.length === 1)
          return [
            ...Array.from({ length: 20 }, (_, index) => [
              {
                type: "tool-input-start" as const,
                id: `browser-${index}`,
                toolName: "browser",
                providerExecuted: true,
                dynamic: true,
              },
              { type: "tool-input-end" as const, id: `browser-${index}` },
              {
                type: "tool-call" as const,
                toolCallId: `browser-${index}`,
                toolName: "browser",
                input: JSON.stringify({ page: index }),
                providerExecuted: true,
                dynamic: true,
              },
              {
                type: "tool-result" as const,
                toolCallId: `browser-${index}`,
                toolName: "browser",
                result: {
                  result: { content: [{ type: "image", data: payload }] },
                },
                providerExecuted: true,
                dynamic: true,
              },
            ]).flat(),
            { type: "text-start", id: "reply" },
            {
              type: "text-delta",
              id: "reply",
              delta: "Read 50 posts. Payments and model releases stood out.",
            },
            { type: "text-end", id: "reply" },
            finish,
          ];
        if (fixture.calls.length === 2) {
          const prompt = fixture.calls[1]!.prompt;
          const users = prompt.filter((message) => message.role === "user");
          expect(users).toHaveLength(2);
          expect(JSON.stringify(prompt)).toContain("which one is the biggest");
          expect(JSON.stringify(prompt)).toContain("Read 50 posts");
          expect(JSON.stringify(prompt)).toContain("[truncated]");
          expect(JSON.stringify(prompt).length).toBeLessThan(100_000);
        }
        return answer;
      };
      yield* execute(fixture.run);
      fixture.run.input.parts = [
        { type: "text", text: "which one is the biggest" },
      ];
      yield* execute(fixture.run);

      expect(fixture.calls).toHaveLength(2);
      for (const text of ["Explain the impact", "What should I watch next?"]) {
        const previous = fixture.calls.at(-1)!.prompt;
        fixture.run.input.parts = [{ type: "text", text }];
        yield* execute(fixture.run);
        const next = fixture.calls.at(-1)!.prompt;
        expect(next.slice(0, previous.length)).toEqual(previous);
      }
      expect(fixture.calls).toHaveLength(4);
      expect(JSON.stringify(fixture.calls[3]!.prompt)).not.toContain(payload);
      const { history } = yield* fixture.session.readTranscriptPage({
        sessionID: fixture.run.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(history.some(isUsableSummary)).toBe(false);
      expect(history.at(-1)?.info).toMatchObject({
        agent: "analyst",
        finish: "stop",
      });
      expect(
        history[1]?.parts.find((part) => part.type === "tool"),
      ).toMatchObject({
        state: {
          output: {
            type: "json",
            value: { result: { content: [{ type: "image", data: payload }] } },
          },
        },
      });
      for (const message of history)
        for (const part of message.parts)
          if (part.type === "tool" && part.state.status === "completed")
            expect(part.state.time.compacted).toBeUndefined();
    }),
  );
});

test("a failed deterministic action preserves history and never starts a normal model step", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.model = { ...model, limit: { context: 2000, output: 1000 } };
      fixture.run.input.parts = [
        { type: "text", text: "Original research context. ".repeat(500) },
      ];
      fixture.source = () => [
        {
          ...finish,
          finishReason:
            fixture.calls.length === 1
              ? { unified: "tool-calls", raw: "tool-calls" }
              : { unified: "length", raw: "length" },
        },
      ];

      const exit = yield* Effect.exit(execute(fixture.run));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fixture.calls).toHaveLength(2);
      const history = yield* readHistory(fixture.run.sessionID);
      expect(JSON.stringify(history)).toContain("Original research context");
      expect(
        history.some(
          (message) =>
            message.info.role === "assistant" && message.info.summary,
        ),
      ).toBe(false);
    }),
  );
});

test("materializes input evidence and text attachments atomically before model replay", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.run.input.parts = [
        {
          id: "prt_document",
          type: "context",
          context: {
            kind: "document",
            title: "Research",
            text: "Read this",
            evidence: [candidate],
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ];
      yield* execute(fixture.run);
      const transcript = yield* fixture.session.listMessages({
        sessionID: fixture.run.sessionID,
        limit: 100,
      });
      const user = transcript.items[0];
      const evidence = user?.parts.find((part) => part.type === "evidence");
      assertExists(evidence, "Document evidence must be committed");
      expect(evidence).toMatchObject({
        sourcePartID: "prt_document",
        blocks: [{ text: "Exact evidence", id: "b0" }],
      });
      expect(JSON.stringify(fixture.calls[0]?.prompt)).toContain(
        `${evidence.evidenceID}#b0`,
      );
      expect(JSON.stringify(fixture.calls[0]?.prompt)).toContain("hello");
    }),
  );
});

test.each<AgentPromptInput["parts"][number]>([
  { type: "agent", name: "analyst" },
  { type: "file", mime: "text/plain", url: "file:///tmp/private.txt" },
  { type: "file", mime: "text/plain", url: "data:text/plain;base64,%%%" },
  { type: "context", context: { kind: "dig_in", quoteText: "quote" } },
])(
  "rejects unsupported or invalid $type input before creating partial transcripts",
  async (part) => {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.run.input.parts.push(part);
        const exit = yield* Effect.exit(execute(fixture.run));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(fixture.calls).toHaveLength(0);
        expect(
          (yield* fixture.session.listMessages({
            sessionID: fixture.run.sessionID,
            limit: 100,
          })).items,
        ).toHaveLength(0);
      }),
    );
  },
);

test("binds committed tool identity, progress, permission, evidence and attachment output", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const database = yield* Database.Service;
      const requests: Permission.AskInput[] = [];
      const definition = yield* Tool.init(
        yield* Tool.define(
          "echo",
          Effect.succeed({
            description: "Echo with evidence",
            parameters: Schema.Struct({}),
            execute: (_, context) =>
              Effect.gen(function* () {
                const stored = yield* fixture.session
                  .getMessage({
                    sessionID: context.sessionID,
                    messageID: context.messageID,
                  })
                  .pipe(Effect.provideService(Database.Service, database));
                expect(stored?.parts).toContainEqual(
                  expect.objectContaining({
                    type: "tool",
                    callID: context.callID,
                  }),
                );
                expect(context.messages[0]?.info.role).toBe("user");
                yield* context.metadata({
                  title: "Reading",
                  metadata: { progress: 1 },
                });
                yield* context.ask({
                  permission: "echo",
                  patterns: ["/source"],
                  always: ["/source"],
                  metadata: { purpose: "test" },
                });
                return {
                  title: "Result",
                  metadata: { complete: true },
                  output: { type: "text" as const, value: "superseded" },
                  evidence: [candidate],
                  attachments: [
                    {
                      type: "file" as const,
                      mime: "image/png",
                      url: "data:image/png;base64,aGVsbG8=",
                    },
                  ],
                };
              }),
          }),
        ),
      );
      fixture.source = () =>
        fixture.calls.length === 1
          ? [
              { type: "tool-input-start", id: "call", toolName: "echo" },
              { type: "tool-input-end", id: "call" },
              {
                type: "tool-call",
                toolCallId: "call",
                toolName: "echo",
                input: "{}",
              },
              {
                ...finish,
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              },
            ]
          : answer;
      yield* execute(fixture.run).pipe(
        Effect.provideService(ToolRegistry.Service, {
          ids: () => Effect.succeed(["echo"]),
          all: () => Effect.succeed([definition]),
        }),
        Effect.provideService(Permission.Service, {
          ...permission,
          ask: (input) =>
            Effect.sync(() => requests.push(input)).pipe(
              Effect.andThen(permission.ask(input)),
            ),
        }),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        resources: ["/source"],
        source: { type: "tool", callID: "call" },
      });
      const transcript = yield* fixture.session.listMessages({
        sessionID: fixture.run.sessionID,
        limit: 100,
      });
      const parts = transcript.items.flatMap((message) => message.parts);
      const evidence = parts.find((part) => part.type === "evidence");
      assertExists(evidence, "Tool evidence must be committed");
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({
            status: "completed",
            title: "Result",
            metadata: { progress: 1, complete: true },
            attachments: [
              expect.objectContaining({
                id: expect.stringMatching(/^prt_/),
                type: "file",
              }),
            ],
          }),
        }),
      );
      expect(JSON.stringify(fixture.calls[1]?.prompt)).toContain(
        `${evidence.evidenceID}#b0`,
      );
      expect(JSON.stringify(fixture.calls[1]?.prompt)).not.toContain(
        "superseded",
      );
    }),
  );
});

test.each(["intent", "model"] as const)(
  "%s tool call applies permissions according to its accepted call ID",
  async (entry) => {
    await run(
      (fixture) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service;
          const requests: Permission.AskInput[] = [];
          const definition = yield* Tool.init(
            yield* Tool.define(
              "workflow",
              Effect.succeed({
                description: "Tool with multiple permission actions",
                parameters: Schema.JsonObject,
                execute: (_, context) =>
                  Effect.gen(function* () {
                    for (const action of ["workflow", "read", "write"]) {
                      yield* context.ask({
                        permission: action,
                        patterns: ["/source"],
                        always: ["/source"],
                        metadata: {},
                      });
                    }
                    return {
                      title: "Result",
                      metadata: {},
                      output: { type: "text" as const, value: "Done" },
                    };
                  }),
              }),
            ),
          );
          if (entry === "intent") {
            fixture.run.input.parts = [
              {
                type: "workflow",
                workflow: "workspace:test.workflow.ts",
                args: {},
              },
            ];
          }
          fixture.source = () =>
            entry === "model" && fixture.calls.length === 1
              ? [
                  {
                    type: "tool-input-start",
                    id: "call",
                    toolName: "workflow",
                  },
                  { type: "tool-input-end", id: "call" },
                  {
                    type: "tool-call",
                    toolCallId: "call",
                    toolName: "workflow",
                    input: "{}",
                  },
                  {
                    ...finish,
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  },
                ]
              : answer;
          yield* execute(fixture.run).pipe(
            Effect.provideService(ToolRegistry.Service, {
              ids: () => Effect.succeed(["workflow"]),
              all: () => Effect.succeed([definition]),
            }),
            Effect.provideService(Permission.Service, {
              ...permission,
              ask: (request) =>
                Effect.sync(() => requests.push(request)).pipe(
                  Effect.andThen(permission.ask(request)),
                ),
            }),
          );
          expect(requests.map((request) => request.action)).toEqual(
            entry === "intent" ? [] : ["workflow", "read"],
          );
          const transcript = yield* readHistory(fixture.run.sessionID);
          const tools = transcript
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool");
          expect(tools).toHaveLength(1);
          expect(tools[0]?.state.status).toBe(
            entry === "intent" ? "completed" : "error",
          );
          // The accepted call does not expose denied tools in the next model step.
          if (entry === "intent")
            expect(fixture.calls[0]?.tools).toBeUndefined();
        }),
      {
        agents: {
          analyst: {
            permission: [
              { action: "*", resource: "*", decision: "deny" },
              {
                action: "workflow",
                resource: "*",
                decision: entry === "intent" ? "deny" : "allow",
              },
            ],
          },
        },
      },
    );
  },
);

test("omits tools forbidden by the selected profile", async () => {
  await run(
    (fixture) =>
      Effect.gen(function* () {
        yield* execute(fixture.run);
        expect(fixture.calls[0]?.tools?.map((tool) => tool.name)).not.toContain(
          "echo",
        );
        expect(fixture.calls[0]?.tools?.map((tool) => tool.name)).toContain(
          "resource_read",
        );
      }),
    {
      agents: {
        analyst: {
          permission: [{ action: "echo", resource: "*", decision: "deny" }],
        },
      },
    },
  );
});

test.each(
  [CLAUDE_CODE, CODEX].flatMap((providerID) =>
    [undefined, "ask"].map((permissionMode) => ({
      providerID,
      permissionMode,
    })),
  ),
)(
  "$providerID routes native approvals according to saved mode $permissionMode",
  async ({ providerID, permissionMode }) => {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.model = { ...model, providerID };
        fixture.run.input.model.providerID = providerID;
        const requests: Permission.AskInput[] = [];
        fixture.source = async () => {
          const options = fixture.calls.at(-1)!.providerOptions!;
          if (providerID === CLAUDE_CODE) {
            const native = options[
              CLAUDE_CODE
            ] as unknown as ClaudeCodeProviderOptions;
            expect(native.cwd).toBe(fixture.workspace.root);
            expect(
              await native.canUseTool!(
                "Bash",
                { command: "pwd" },
                {
                  signal: new AbortController().signal,
                  toolUseID: "native",
                  requestId: "approval",
                },
              ),
            ).toMatchObject({ behavior: "allow" });
          } else {
            const native = options[
              "codex-app-server"
            ] as unknown as CodexProviderOptions;
            expect(native.cwd).toBe(fixture.workspace.root);
            expect(
              await native.requests!(
                {
                  method: "item/commandExecution/requestApproval",
                  params: {
                    threadId: "thread",
                    turnId: "turn",
                    itemId: "native",
                    command: "pwd",
                  },
                },
                { signal: new AbortController().signal },
              ),
            ).toMatchObject({ decision: "accept" });
          }
          return answer;
        };
        const permission = yield* Permission.Service;
        yield* execute(fixture.run).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(
              permissionMode ? { models: { permissionMode } } : {},
            ),
          ),
          Effect.provideService(Permission.Service, {
            ...permission,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request);
              }),
          }),
        );
        expect(requests).toEqual(
          permissionMode === "ask"
            ? [
                expect.objectContaining({
                  sessionID: fixture.run.sessionID,
                  agent: null,
                  action: "run_command",
                  resources: ["pwd"],
                }),
              ]
            : [],
        );
      }),
    );
  },
);

test("a direct compaction-profile prompt completes as an ordinary turn", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.run.input.agent = "compaction";
      yield* execute(fixture.run);
      expect(fixture.calls).toHaveLength(1);
      const transcript = yield* fixture.session.listMessages({
        sessionID: fixture.run.sessionID,
        limit: 100,
      });
      expect(transcript.items.at(-1)?.info).toMatchObject({
        agent: "compaction",
        finish: "stop",
      });
    }),
  );
});

test("continues after a Resource defect and replays recoverable feedback to the model", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const list = vi
    .spyOn(agentScheduleResource.store, "list")
    .mockImplementationOnce(() => {
      throw new Error("private storage detail");
    });
  try {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.source = () =>
          fixture.calls.length < 3
            ? [
                {
                  type: "tool-input-start",
                  id: `read-${fixture.calls.length}`,
                  toolName: "resource_read",
                },
                { type: "tool-input-end", id: `read-${fixture.calls.length}` },
                {
                  type: "tool-call",
                  toolCallId: `read-${fixture.calls.length}`,
                  toolName: "resource_read",
                  input: JSON.stringify({ resource: "agent_schedule" }),
                },
                {
                  ...finish,
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ]
            : answer;
        yield* execute(fixture.run);
        expect(fixture.calls).toHaveLength(3);
        const replay = JSON.stringify(fixture.calls[1]?.prompt);
        expect(replay).toContain("rejected");
        expect(replay).toContain("Internal server error");
        expect(replay).not.toContain("private storage detail");
        const transcript = yield* fixture.session.listMessages({
          sessionID: fixture.run.sessionID,
          limit: 100,
        });
        const tools = transcript.items
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool");
        expect(tools).toHaveLength(2);
        expect(tools.every((part) => part.state.status === "completed")).toBe(
          true,
        );
      }),
    );
  } finally {
    list.mockRestore();
    report.mockRestore();
  }
});

test("adds one persisted Dig In marker on first successful input and retains copied model context", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      yield* execute(fixture.run);
      const source = yield* fixture.session.readTranscriptPage({
        sessionID: fixture.run.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      const reply = source.history.at(-1)!;
      const part = reply.parts.find((part) => part.type === "text")!;
      const child = yield* fixture.session.digIn({
        sessionID: SessionId.make(fixture.run.sessionID),
        messageID: reply.info.id,
        selection: {
          partId: part.id,
          text: "Done",
          startOffset: 0,
          endOffset: 4,
        },
      });
      fixture.run.sessionID = child.id;
      fixture.run.input.parts = [{ type: "agent", name: "unsupported" }];
      expect(
        Exit.isFailure(yield* execute(fixture.run).pipe(Effect.exit)),
      ).toBe(true);
      expect(
        (yield* fixture.session.listMessages({
          sessionID: child.id,
          limit: Number.MAX_SAFE_INTEGER,
        })).items,
      ).toHaveLength(source.history.length);

      fixture.run.input.parts = [
        { type: "text", text: "Explain the selected result" },
      ];
      yield* execute(fixture.run);
      const first = yield* fixture.session.readTranscriptPage({
        sessionID: child.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      const visible = first.history;
      expect(visible).toHaveLength(2);
      expect(visible[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "context",
            context: { kind: "dig_in", quoteText: "Done" },
          }),
          expect.objectContaining({
            type: "text",
            text: "Explain the selected result",
          }),
        ]),
      );
      const prompt = JSON.stringify(fixture.calls.at(-1)!.prompt);
      expect(prompt).toContain("Help");
      expect(prompt).toContain("The user opened this Dig In");
      expect(prompt.match(/Explain the selected result/g)).toHaveLength(1);

      fixture.run.input.parts = [{ type: "text", text: "Continue" }];
      yield* execute(fixture.run);
      const continued = yield* fixture.session.readTranscriptPage({
        sessionID: child.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(
        continued.history
          .flatMap(({ parts }) => parts)
          .filter(
            (part) => part.type === "context" && part.context.kind === "dig_in",
          ),
      ).toHaveLength(1);
      expect(continued.history).toHaveLength(4);
      expect(
        (yield* fixture.session.readTranscriptPage({
          sessionID: source.session.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history,
      ).toEqual(source.history);
    }),
  );
});
