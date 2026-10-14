import { unusedModelSetup } from "@openchart/server/models/models.test-utils";
// Purpose: Exercises workflow fan-out and synthesis through real admission, Prompt, Processor, and SQLite.

import { CLAUDE_CODE, CODEX, TIER4 } from "@openchart/models/model-tiers";

import { temporaryHome } from "@openchart/server/home.test-utils";
import { Home } from "@openchart/server/home";
import { Database } from "@openchart/server/db";
import { workspaceStore } from "@openchart/server/resources/workspace/store";
import path from "node:path";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import { projectTranscript } from "@openchart/server/agent/publisher/agui/projection";
import { Events } from "@openchart/server/events";
import { from } from "rxjs";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { buildCommand } from "@openchart/server/agent/command/command";
import { submitPrompt } from "@openchart/server/agent/session/submit-prompt";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { Session } from "@openchart/server/agent/session";
import { SessionRunner } from "@openchart/server/agent/session/runner";
import { SessionRunCoordinator } from "@openchart/server/agent/session/execution/coordinator";
import { Permission } from "@openchart/server/agent/permission";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { makeRuntime } from "@openchart/server/runtime";
import { Models } from "@openchart/server/models";
import { executeInvocation } from "@openchart/server/agent/prompt/execute";
import {
  agent,
  defineWorkflow,
  parallel,
} from "@openchart/server/agent/workflow/authoring";
import { assertExists } from "@openchart/utils/assert";
import { Deferred, Effect, Fiber, FileSystem, Schema, Stream } from "effect";
import { expect, test, vi } from "vitest";
import { makeWorkflowHost } from "./host";
import { run } from "./runtime";
import { Workflow } from "./workflow";

// Real TypeScript compilation needs headroom on shared CI runners.
vi.setConfig({ testTimeout: 30_000 });

test("model calls a workspace-authored workflow with tier selection and persists real children", async () => {
  let called = false;
  const f = fixture(async (input, selected) => {
    const text = userText(input);
    if (text.startsWith("SDK_CHILD:")) {
      expect(selected).toMatchObject({ providerID: CODEX, id: "gpt-6-astra" });
      return answer(`ANSWER:${text}`);
    }
    if (text.includes("ROOT_WORKSPACE") && !called) {
      called = true;
      return [
        {
          type: "tool-input-start",
          id: "workspace-call",
          toolName: "workflow",
        },
        { type: "tool-input-end", id: "workspace-call" },
        {
          type: "tool-call",
          toolCallId: "workspace-call",
          toolName: "workflow",
          input: JSON.stringify({
            workflow: "workspace:research.workflow.ts",
            args: { question: "NVDA" },
          }),
        },
        {
          ...finish,
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
        },
      ];
    }
    return answer("WORKSPACE_COMPLETE");
  }, "allow");
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        const { root: home } = yield* Home;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          path.join(home, "wsp_workflow/research.workflow.ts"),
          `
import { defineWorkflow, Schema, Effect, parallel, agent, textPrompt, CODEX, TIER4 } from "@openchart/workflow";
export default defineWorkflow({
  description: "Two independent researchers",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }, { parentPrompt }) => Effect.gen(function* () {
    return yield* parallel(["bull", "bear"].map(role => agent(textPrompt("SDK_CHILD:" + role + ":" + question, { providerID: CODEX, modelID: TIER4 }, parentPrompt.agent))));
  }),
});`,
        );
        yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "workspace-test",
          input: {
            ...prompt,
            parts: [
              {
                type: "text",
                text: "ROOT_WORKSPACE: run the referenced workflow",
              },
            ],
          },
        });
        yield* runner.run({ sessionID: root.id });
        expect(called).toBe(true);
        expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
        const children = (yield* session.list({ parentId: root.id, limit: 10 }))
          .items;
        expect(children).toHaveLength(2);
        for (const child of children) {
          expect(yield* runs.list(child.id)).toEqual([]);
          const childHistory = (yield* session.readTranscriptPage({
            sessionID: child.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history;
          expect(JSON.stringify(childHistory)).toContain("SDK_CHILD:");
          expect(
            childHistory.find((message) => message.info.role === "user")?.info,
          ).toMatchObject({ model: { providerID: CODEX, modelID: TIER4 } });
          expect(
            childHistory.find((message) => message.info.role === "assistant")
              ?.info,
          ).toMatchObject({ providerID: CODEX, modelID: "gpt-6-astra" });
        }
        const history = (yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history;
        const tool = history
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool");
        expect(tool?.type === "tool" && tool.state).toMatchObject({
          status: "completed",
          metadata: {
            workflow: "workspace:research.workflow.ts",
            preparedArgs: { question: "NVDA" },
            hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        if (tool?.type === "tool" && tool.state.status === "completed")
          expect(traceSpans(tool.state.metadata?.trace)).toHaveLength(3);
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

const decodeTrace = Schema.decodeUnknownSync(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                name: Schema.String,
                startTimeUnixNano: Schema.String,
                endTimeUnixNano: Schema.String,
                attributes: Schema.Array(
                  Schema.Struct({
                    key: Schema.String,
                    value: Schema.JsonObject,
                  }),
                ),
                status: Schema.Struct({ code: Schema.Number }),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

function traceSpans(trace: unknown, allowRunning = false) {
  const spans = decodeTrace(trace).resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  for (const span of spans) {
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(BigInt(span.startTimeUnixNano)).toBeGreaterThan(0n);
    if (!allowRunning || span.endTimeUnixNano !== "0")
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(
        BigInt(span.startTimeUnixNano),
      );
  }
  return spans;
}

const model = {
  id: "workflow-test",
  providerID: "openai",
  kind: "language" as const,
  name: "Workflow test",
  capabilities: { input: { text: true }, output: { text: true } },
};
const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const answer = (text: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: text },
  { type: "text-end", id: "text" },
  finish,
];
const prompt: AgentPromptInput = {
  agent: "analyst",
  workspaceId: "wsp_workflow",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [
    {
      type: "workflow",
      id: "prt_workflow",
      workflow: "default:workflows/best-of-n.workflow.ts",
      args: { n: 3, question: "What changes a company valuation?" },
    },
    { type: "text", text: "ROOT_ONLY: acknowledge completion afterwards." },
  ],
};

type Source = (
  input: LanguageModelV4CallOptions,
  selected: { providerID: string; id: string },
) => Promise<
  LanguageModelV4StreamPart[] | ReadableStream<LanguageModelV4StreamPart>
>;
function userText(input: LanguageModelV4CallOptions) {
  const user = input.prompt.filter((message) => message.role === "user").at(-1);
  return (
    user?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? ""
  );
}

function workflowResult(input: LanguageModelV4CallOptions) {
  const part = input.prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .find(
      (part) => part.type === "tool-result" && part.toolName === "workflow",
    );
  if (part?.type !== "tool-result" || part.output.type !== "json")
    throw new Error(
      `The next model turn must receive the workflow JSON result: ${JSON.stringify(part)}`,
    );
  return Schema.decodeUnknownSync(
    Schema.Struct({
      childSessionIds: Schema.Array(Schema.String),
      result: Schema.Json,
    }),
  )(part.output.value);
}

function fixture(
  source: Source,
  workflowPermission: Permission.Decision = "deny",
  echoPermission: Permission.Decision = "allow",
) {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    profiles: {
      agents: {
        analyst: {
          permission: [
            { action: "workflow", resource: "*", decision: workflowPermission },
            { action: "echo", resource: "*", decision: echoPermission },
          ],
        },
      },
    },
  });
  const native = (selected: {
    providerID: string;
    id: string;
  }): LanguageModelV4 => ({
    specificationVersion: "v4",
    provider: selected.providerID,
    modelId: selected.id,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Unexpected generate");
    },
    doStream: async (input) => {
      const result = await source(input, selected);
      return {
        stream:
          result instanceof ReadableStream
            ? result
            : new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] });
                  for (const part of result) controller.enqueue(part);
                  controller.close();
                },
              }),
      };
    },
  });
  const services: Models.Interface = {
    ...unusedModelSetup,
    list: () => Effect.succeed([]),
    getModel: (providerID, id) =>
      Effect.succeed({
        ...model,
        providerID: id === "tier1" ? model.providerID : providerID,
        id:
          providerID === CLAUDE_CODE && id === TIER4
            ? "fable[1m]"
            : providerID === CODEX && id === TIER4
              ? "gpt-6-astra"
              : id === "tier1"
                ? model.id
                : id,
      }),
    getLanguage: (selected) => Effect.succeed(native(selected)),
  };
  const setup = Effect.gen(function* () {
    const { root: home } = yield* Home;
    const fs = yield* FileSystem.FileSystem;
    const { db } = yield* Database.Service;
    for (const id of ["wsp_workflow", "wsp_child"]) {
      const root = path.join(home, id);
      yield* fs.makeDirectory(root);
      yield* db.transaction((tx) =>
        workspaceStore.insert(tx, { id, revision: 1, body: { root } }),
      );
    }
    const session = yield* Session.Service;
    const runs = yield* AgentRunStore.Service;
    const runner = yield* SessionRunner.Service;
    const root = yield* session.create({ title: "Workflow integration" });
    return { session, runs, runner, root };
  });
  return { runtime, services, setup };
}

test("model-selected workflows read Resources with only workflow permission", async () => {
  let called = false;
  let result: unknown;
  const f = fixture(async (input) => {
    if (!called) {
      called = true;
      return [
        {
          type: "tool-input-start",
          id: "read-workspace",
          toolName: "workflow",
        },
        { type: "tool-input-end", id: "read-workspace" },
        {
          type: "tool-call",
          toolCallId: "read-workspace",
          toolName: "workflow",
          input: JSON.stringify({
            workflow: "workspace:read-resource.workflow.ts",
            args: { id: "wsp_child" },
          }),
        },
        {
          ...finish,
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
        },
      ];
    }
    result = workflowResult(input).result;
    return answer("Read the workspace");
  }, "allow");
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        const { root: home } = yield* Home;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          path.join(home, "wsp_workflow/read-resource.workflow.ts"),
          `
import { defineWorkflow, Effect, parallel, phase, Schema, resource } from "@openchart/workflow";
export default defineWorkflow({
  description: "Read current workspace state",
  args: Schema.Struct({ id: Schema.String }),
  run: ({ id }) => phase("Read Resources", Effect.gen(function* () {
    const failures = yield* parallel([
      resource.get("unknown", id, Schema.Json),
      resource.get("workspace", "bad-id", Schema.Json),
      resource.get("workspace", "wsp_missing", Schema.Json),
      resource.get("workspace", id, Schema.Struct({ root: Schema.Number })),
    ]);
    return {
      workspace: yield* resource.get("workspace", id, Schema.Struct({ id: Schema.String, root: Schema.String })),
      failures,
    };
  })),
});`,
        );
        const permission = yield* Permission.Service;
        const ask = vi.fn(permission.ask);
        yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "read-resource",
          input: {
            ...prompt,
            parts: [{ type: "text", text: "Read the child workspace" }],
          },
        });
        yield* runner
          .run({ sessionID: root.id })
          .pipe(
            Effect.provideService(Permission.Service, { ...permission, ask }),
          );
        expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
        expect(result).toEqual({
          workspace: { id: "wsp_child", root: path.join(home, "wsp_child") },
          failures: Array.from({ length: 4 }, () => ({
            status: "error",
            error: { name: expect.any(String), message: expect.any(String) },
          })),
        });
        const history = (yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: 1,
        })).history;
        const activity = projectTranscript(history).find(
          (message) => message.role === "activity",
        );
        assertExists(activity, "The phase publishes a workflow Activity");
        if (activity.role !== "activity") throw new Error("Expected Activity");
        const details = Schema.decodeUnknownSync(Schema.JsonObject)(
          activity.content.details,
        );
        expect(traceSpans(details.trace).map((span) => span.name)).toEqual([
          "Workflow.phase",
          "Workflow.parallel",
        ]);
        expect(ask.mock.calls.map(([request]) => request.action)).toEqual([
          "workflow",
        ]);
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test("live workflow OTLP Activity deltas converge with persisted history through the official AG-UI reducer", async () => {
  const f = fixture(async (input) =>
    answer(`Answer: ${userText(input).split("\n")[0]}`),
  );
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        const events = yield* Events.Service;
        const finished = yield* Deferred.make<void>();
        const received: AGUIEvent[] = [];
        const stream = yield* events.allBounded(1024);
        yield* Stream.runForEach(stream, (payload) =>
          Effect.gen(function* () {
            if (payload.type !== AgentEvent.type) return;
            const { data } = Schema.decodeUnknownSync(AgentEvent)(payload);
            if (data.sessionID !== root.id) return;
            received.push(data.event);
            if (data.event.type === EventType.RUN_FINISHED)
              yield* Deferred.succeed(finished, undefined);
          }),
        ).pipe(Effect.forkScoped);
        yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "trace-activity",
          input: prompt,
        });
        yield* runner.run({ sessionID: root.id });
        yield* Deferred.await(finished);
        const snapshots = received.filter(
          (event) => event.type === EventType.ACTIVITY_SNAPSHOT,
        );
        expect(snapshots).toHaveLength(1);
        expect(
          received.filter((event) => event.type === EventType.ACTIVITY_DELTA)
            .length,
        ).toBeGreaterThanOrEqual(8);
        // A reconnect starts from the same persisted ToolPart; no separate trace store.
        const history = (yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history;
        const cold = projectTranscript(history);
        const client = new (class extends AbstractAgent {
          /** Replay the actual committed events. @example client.runAgent(); */
          run() {
            return from(
              received.slice(
                received.findIndex(
                  (event) => event.type === EventType.RUN_STARTED,
                ),
              ),
            );
          }
        })({ threadId: root.id, initialState: { messageInfo: {} } });
        yield* Effect.promise(() => client.runAgent());
        expect(client.messages).toEqual(cold);
        const activity = client.messages.find(
          (message) => message.role === "activity",
        );
        assertExists(activity, "The workflow publishes a native Activity");
        if (activity.role !== "activity") throw new Error("Expected Activity");
        const details = Schema.decodeUnknownSync(Schema.JsonObject)(
          activity.content.details,
        );
        expect(traceSpans(details.trace)).toHaveLength(7);
        // Input admission may replace history, but trace updates must use Activity.
        expect(
          received
            .filter((event) => event.type === EventType.MESSAGES_SNAPSHOT)
            .flatMap((event) => event.messages)
            .some((message) => message.role === "activity"),
        ).toBe(false);
      }).pipe(Effect.provideService(Models.Service, f.services), Effect.scoped),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test("automatically exposes child transcripts when the author returns only business output", async () => {
  let references: readonly string[] = [];
  let read = false;
  let verified = false;
  const f = fixture(async (input) => {
    const text = userText(input);
    if (text.startsWith("CHILD_")) return answer(`Detail: ${text}`);
    const result = workflowResult(input);
    expect(result.result).toEqual({ answer: "Ready" });
    expect(result.childSessionIds).toHaveLength(2);
    references = result.childSessionIds;
    if (!read) {
      read = true;
      return [
        {
          type: "tool-input-start",
          id: "read-child",
          toolName: "read_transcript",
        },
        { type: "tool-input-end", id: "read-child" },
        {
          type: "tool-call",
          toolCallId: "read-child",
          toolName: "read_transcript",
          input: JSON.stringify({ session_id: references[0], cursor: null }),
        },
        {
          ...finish,
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
        },
      ];
    }
    expect(JSON.stringify(input.prompt)).toContain("Detail: CHILD_A_FIRST");
    expect(JSON.stringify(input.prompt)).toContain("Detail: CHILD_A_FOLLOW_UP");
    verified = true;
    return answer("Verified the child transcript");
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        const fs = yield* FileSystem.FileSystem;
        const { root: home } = yield* Home;
        yield* fs.writeFileString(
          path.join(home, "wsp_workflow/references.workflow.ts"),
          `
import { agent, defineWorkflow, Effect, Schema, textPrompt } from "@openchart/workflow";
export default defineWorkflow({
  description: "Return only the business answer",
  args: Schema.Struct({}),
  run: (_, { parentPrompt }) => Effect.gen(function* () {
    const prompt = (text: string) => textPrompt(text, parentPrompt.model, parentPrompt.agent);
    const first = yield* agent(prompt("CHILD_A_FIRST"));
    yield* agent(prompt("CHILD_B"));
    yield* agent(prompt("CHILD_A_FOLLOW_UP"), { sessionId: first.sessionId });
    return { answer: "Ready" };
  }),
});
`,
        );
        yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "references",
          input: {
            ...prompt,
            parts: [
              {
                type: "workflow",
                workflow: "workspace:references.workflow.ts",
                args: {},
              },
            ],
          },
        });
        yield* runner.run({ sessionID: root.id });
        expect(verified).toBe(true);
        expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
        const history = (yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: 10,
        })).history;
        const tools = history
          .flatMap(({ parts }) => parts)
          .filter((part) => part.type === "tool");
        expect(tools.map((part) => part.tool)).toEqual([
          "workflow",
          "read_transcript",
        ]);
        expect(tools[0]!.childSessionIds).toEqual(references);
        expect(tools[0]!.state).toMatchObject({
          output: {
            type: "json",
            value: { childSessionIds: references, result: { answer: "Ready" } },
          },
        });
        const children = (yield* session.list({ parentId: root.id, limit: 10 }))
          .items;
        expect(children.map((child) => child.id).sort()).toEqual(
          [...references].sort(),
        );
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test.each(["intent", "model"] as const)(
  "%s workflow fans out concurrently, synthesizes, and persists only one Run",
  async (entry) => {
    const started: string[] = [];
    const completed: string[] = [];
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let modelInvocation = false;
    let summaryPrompt = "";
    let rootID = "";
    const f = fixture(
      async (input) => {
        const text = userText(input);
        if (text.startsWith("Research ") || text.startsWith("Synthesize ")) {
          // Accepted root intent must not expose denied tools in its child Sessions.
          expect(input.tools?.some((tool) => tool.name === "workflow")).toBe(
            entry === "model",
          );
        }
        if (text.startsWith("Research ")) {
          expect(text).not.toContain("ROOT_ONLY");
          started.push(text);
          if (started.length === 3) {
            try {
              await f.runtime.runPromise(
                Effect.gen(function* () {
                  const session = yield* Session.Service;
                  const tool = (yield* session.readTranscriptPage({
                    sessionID: rootID,
                    turnLimit: Number.MAX_SAFE_INTEGER,
                  })).history
                    .flatMap((message) => message.parts)
                    .find((part) => part.type === "tool");
                  const spans = traceSpans(tool?.state.metadata?.trace, true);
                  expect(spans).toHaveLength(5);
                  expect([...(tool?.childSessionIds ?? [])].sort()).toEqual(
                    spans
                      .filter((span) => span.name === "Workflow.agent")
                      .map(
                        (span) =>
                          span.attributes.find(
                            (attribute) =>
                              attribute.key === "openchart.session.id",
                          )?.value.stringValue,
                      )
                      .sort(),
                  );
                  expect(
                    spans.every((span) => span.endTimeUnixNano === "0"),
                  ).toBe(true);
                  for (const span of spans.filter(
                    (item) => item.name === "Workflow.agent",
                  ))
                    expect(span.attributes).toContainEqual({
                      key: "openchart.session.id",
                      value: { stringValue: expect.any(String) },
                    });
                }),
              );
            } finally {
              release();
            }
          }
          await allStarted;
          completed.push(text);
          return answer(`Finding: ${text}`);
        }
        if (text.startsWith("Synthesize ")) {
          expect(completed).toHaveLength(3);
          summaryPrompt = text;
          return answer("Combined research answer");
        }
        if (entry === "model" && !modelInvocation) {
          modelInvocation = true;
          return [
            {
              type: "tool-input-start",
              id: "model-workflow",
              toolName: "workflow",
            },
            { type: "tool-input-end", id: "model-workflow" },
            {
              type: "tool-call",
              toolCallId: "model-workflow",
              toolName: "workflow",
              input: JSON.stringify({
                workflow: "default:workflows/best-of-n.workflow.ts",
                args: { n: 3, question: "What changes a company valuation?" },
              }),
            },
            {
              ...finish,
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ];
        }
        expect(text).toContain("ROOT_ONLY");
        expect(workflowResult(input).childSessionIds).toHaveLength(4);
        return answer("Root acknowledgement");
      },
      entry === "model" ? "allow" : "deny",
    );
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          rootID = root.id;
          // Pre-existing root history must never be forked into a researcher.
          yield* session.createMessage({
            info: {
              id: "msg_old",
              sessionID: root.id,
              role: "user",
              agent: "analyst",
              model: prompt.model,
              time: { created: 1 },
            },
            parts: [
              {
                id: "prt_old",
                messageID: "msg_old",
                type: "text",
                text: "PRIVATE_PARENT_HISTORY",
              },
            ],
          });
          const request = {
            sessionID: root.id,
            sessionIntentID: "intent",
            input:
              entry === "intent"
                ? prompt
                : {
                    ...prompt,
                    workspaceId: undefined,
                    parts: prompt.parts.filter((part) => part.type === "text"),
                  },
          };
          const workspaceId = request.input.workspaceId;
          const accepted = yield* runs.enqueue(request);
          yield* runner.run({ sessionID: root.id });
          expect(yield* runs.list(root.id)).toMatchObject([
            { id: accepted.id, status: "completed" },
          ]);
          const children = (yield* session.list({
            parentId: root.id,
            limit: 20,
          })).items;
          expect(children).toHaveLength(4);
          for (const child of children) {
            expect(child.kind).toBe("delegate");
            expect(yield* runs.list(child.id)).toEqual([]);
            const history = (yield* session.readTranscriptPage({
              sessionID: child.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            })).history;
            expect(history).toHaveLength(2);
            const home = yield* Home;
            expect(history[1]?.info).toMatchObject({
              path: {
                cwd: workspaceId
                  ? path.join(home.root, workspaceId)
                  : path.join(home.root, "workspaces", "default"),
              },
            });
            expect(
              history
                .map((message) => message.info)
                .find((info) => info.role === "user")?.workspaceId,
            ).toBe(workspaceId);
            expect(JSON.stringify(history)).not.toContain(
              "PRIVATE_PARENT_HISTORY",
            );
            expect(JSON.stringify(history)).not.toContain("ROOT_ONLY");
          }
          const history = (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history;
          expect(
            history
              .map((message) => message.info)
              .filter((info) => info.role === "user")
              .at(-1)?.workspaceId,
          ).toBe(workspaceId);
          expect((yield* runs.getByIntent("intent"))?.input).toEqual(
            accepted.input,
          );
          const tools = history
            .flatMap((message) => message.parts)
            .filter((part): part is ToolPart => part.type === "tool");
          expect(tools).toHaveLength(1);
          expect([...tools[0]!.childSessionIds].sort()).toEqual(
            children.map((child) => child.id).sort(),
          );
          expect(tools[0]?.state).toMatchObject({
            status: "completed",
            metadata: {
              workflow: "default:workflows/best-of-n.workflow.ts",
              preparedArgs: {
                n: 3,
                question: "What changes a company valuation?",
              },
            },
          });
          expect(tools[0]?.state.metadata).not.toHaveProperty("workflowPartId");
          const spans = traceSpans(tools[0]?.state.metadata?.trace);
          expect(spans).toHaveLength(7);
          expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
          expect(new Set(spans.map((span) => span.spanId)).size).toBe(7);
          for (const span of spans) {
            expect(span.status.code).toBe(1);
            expect(BigInt(span.endTimeUnixNano)).toBeGreaterThan(
              BigInt(span.startTimeUnixNano),
            );
          }
          const parallelSpan = spans.find(
            (span) => span.name === "Workflow.parallel",
          )!;
          const agents = spans.filter((span) => span.name === "Workflow.agent");
          expect(agents).toHaveLength(4);
          const summarySpan = agents[3]!;
          expect(summarySpan.parentSpanId).not.toBe(parallelSpan.spanId);
          expect(BigInt(parallelSpan.endTimeUnixNano)).toBeLessThanOrEqual(
            BigInt(summarySpan.startTimeUnixNano),
          );
          for (const researcher of agents.slice(0, 3)) {
            expect(researcher.parentSpanId).toBe(parallelSpan.spanId);
            expect(BigInt(researcher.startTimeUnixNano)).toBeGreaterThanOrEqual(
              BigInt(parallelSpan.startTimeUnixNano),
            );
            expect(BigInt(researcher.endTimeUnixNano)).toBeLessThanOrEqual(
              BigInt(parallelSpan.endTimeUnixNano),
            );
          }
          expect(
            agents
              .map(
                (span) =>
                  span.attributes.find(
                    (attribute) => attribute.key === "openchart.session.id",
                  )?.value.stringValue,
              )
              .sort(),
          ).toEqual(children.map((child) => child.id).sort());
          expect(summaryPrompt).toContain("Finding: Research attempt 1");
          expect(summaryPrompt).toContain("Finding: Research attempt 2");
          expect(summaryPrompt).toContain("Finding: Research attempt 3");
          expect(history.at(-1)?.parts).toContainEqual(
            expect.objectContaining({
              type: "text",
              text: "Root acknowledgement",
            }),
          );
          // Admission replay and a second queue drain must not repeat the workflow.
          expect((yield* runs.enqueue(request)).id).toBe(accepted.id);
          yield* runner.run({ sessionID: root.id });
          expect(started).toHaveLength(3);
        }).pipe(Effect.provideService(Models.Service, f.services)),
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);

test.each([1, 7])(
  "built best-of-n Parts run %i researchers after ordinary prompt submission",
  async (n) => {
    const research: string[] = [];
    let summaries = 0;
    const f = fixture(async (input) => {
      const text = userText(input);
      if (text.startsWith("Research ")) {
        expect(text).toContain("research Google and its competitors");
        research.push(text);
        return answer(`Finding ${research.length}`);
      }
      if (text.startsWith("Synthesize ")) {
        expect(research).toHaveLength(n);
        for (let index = 1; index <= n; index++)
          expect(text).toContain(`Finding ${index}`);
        summaries++;
      }
      return answer("Combined research answer");
    });
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          const parts = yield* buildCommand({
            command: "best-of-n",
            arguments: `${n} research Google and its competitors`,
          });
          expect(yield* runs.list(root.id)).toEqual([]);
          const request = {
            sessionID: root.id,
            sessionIntentID: `command-best-of-${n}`,
            input: { ...prompt, parts },
          };
          const accepted = yield* submitPrompt(request);
          expect(accepted.input.parts).toEqual([
            {
              type: "workflow",
              workflow: "default:workflows/best-of-n.workflow.ts",
              args: { n, question: "research Google and its competitors" },
            },
          ]);
          yield* runner.run({ sessionID: root.id });
          expect(research).toHaveLength(n);
          expect(summaries).toBe(1);
          expect(yield* runs.list(root.id)).toMatchObject([
            { id: accepted.id, status: "completed" },
          ]);
          const children = (yield* session.list({
            parentId: root.id,
            limit: 20,
          })).items;
          expect(children).toHaveLength(n + 1);
          for (const child of children)
            expect(yield* runs.list(child.id)).toEqual([]);
          const history = (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history;
          const tool = history
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool");
          expect(tool?.state).toMatchObject({
            status: "completed",
            metadata: {
              preparedArgs: {
                n,
                question: "research Google and its competitors",
              },
            },
          });
          expect((yield* submitPrompt(request)).id).toBe(accepted.id);
          yield* runner.run({ sessionID: root.id });
          expect(research).toHaveLength(n);
          expect(summaries).toBe(1);
        }).pipe(
          Effect.provideService(Models.Service, f.services),
          Effect.provideService(SessionExecution.Service, {
            active: Effect.succeed(new Set<string>()),
            wake: () => Effect.void,
            interrupt: () => Effect.void,
          }),
        ),
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);

test.each([
  {
    roundCount: 1,
    parentModel: prompt.model,
    selectedModel: { providerID: model.providerID, id: model.id },
  },
  {
    roundCount: 3,
    parentModel: { providerID: CLAUDE_CODE, modelID: TIER4 },
    selectedModel: { providerID: CLAUDE_CODE, id: "fable[1m]" },
  },
  {
    roundCount: 3,
    parentModel: { providerID: CODEX, modelID: TIER4 },
    selectedModel: { providerID: CODEX, id: "gpt-6-astra" },
  },
])(
  "/multi-turn-debate runs $roundCount rounds with $parentModel.providerID/$parentModel.modelID and summarizes every turn in a fresh Session",
  async ({ roundCount, parentModel, selectedModel }) => {
    const topic = "Should public transit be free?";
    let rootID = "";
    const calls: string[] = [];
    const liveSpanIds: string[] = [];
    let summaryPrompt = "";
    const f = fixture(async (input, selected) => {
      const text = userText(input);
      if (
        text.startsWith(
          `Summarize this complete ${roundCount}-round affirmative/negative debate`,
        )
      ) {
        expect(calls).toHaveLength(roundCount * 2);
        expect(selected).toMatchObject(selectedModel);
        expect(text).toContain(`Topic: ${topic}`);
        expect(text).toContain("neutral analyst");
        expect(text.split("Full debate transcript:\n")[1]).toBe(
          Array.from({ length: roundCount }, (_, index) => index + 1)
            .map(
              (round) =>
                `Round ${round}\nAffirmative:\nAffirmative statement ${round}\n\nNegative:\nNegative statement ${round}`,
            )
            .join("\n\n"),
        );
        expect(JSON.stringify(input.prompt)).not.toContain("ROOT_ONLY");
        expect(
          input.prompt.filter((message) => message.role === "user"),
        ).toHaveLength(1);
        expect(
          input.prompt.filter((message) => message.role === "assistant"),
        ).toHaveLength(0);
        summaryPrompt = text;
        return answer("Balanced debate summary");
      }
      if (!text.startsWith("Debate round ")) return answer("Debate completed");
      const turn = calls.length;
      const round = Math.floor(turn / 2) + 1;
      const name = turn % 2 === 0 ? "Affirmative" : "Negative";
      expect(selected).toMatchObject(selectedModel);
      expect(text).toContain(`Debate round ${round}/${roundCount}.`);
      expect(text).toContain(`Topic: ${topic}`);
      expect(text).toContain(
        `You are the ${name === "Affirmative" ? "affirmative" : "negative"} side`,
      );
      expect(JSON.stringify(input.prompt)).not.toContain("ROOT_ONLY");
      expect(
        input.prompt.filter((message) => message.role === "user"),
      ).toHaveLength(round);
      const priorAnswers = input.prompt.filter(
        (message) => message.role === "assistant",
      );
      expect(priorAnswers).toHaveLength(round - 1);
      for (let priorRound = 1; priorRound < round; priorRound++)
        expect(JSON.stringify(priorAnswers)).toContain(
          `${name} statement ${priorRound}`,
        );
      if (turn > 0) expect(text).toContain(calls[turn - 1]);
      expect(text.includes("closing statement")).toBe(round === roundCount);
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const session = yield* Session.Service;
          const tool = (yield* session.readTranscriptPage({
            sessionID: rootID,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool");
          const spans = traceSpans(tool?.state.metadata?.trace, true).filter(
            (span) => span.name === "Workflow.agent",
          );
          expect(spans).toHaveLength(turn + 1);
          expect(spans.at(-1)?.endTimeUnixNano).toBe("0");
          liveSpanIds.push(spans.at(-1)!.spanId);
          expect(spans.at(-1)?.attributes).toContainEqual({
            key: "openchart.session.id",
            value: { stringValue: expect.any(String) },
          });
          expect(
            spans
              .slice(0, -1)
              .every((span) => BigInt(span.endTimeUnixNano) > 0n),
          ).toBe(true);
        }),
      );
      const statement = `${name} statement ${round}`;
      calls.push(statement);
      return answer(statement);
    });
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          rootID = root.id;
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "debate",
            input: {
              ...prompt,
              model: parentModel,
              parts: [
                ...(yield* buildCommand({
                  command: "multi-turn-debate",
                  arguments: `${roundCount} ${topic}`,
                })),
                {
                  type: "text",
                  text: "ROOT_ONLY: acknowledge the debate afterwards.",
                },
              ],
            },
          });
          yield* runner.run({ sessionID: root.id });
          expect(calls).toEqual(
            Array.from({ length: roundCount }, (_, index) => [
              `Affirmative statement ${index + 1}`,
              `Negative statement ${index + 1}`,
            ]).flat(),
          );
          expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
          const children = (yield* session.list({
            parentId: root.id,
            limit: 20,
          })).items;
          expect(children).toHaveLength(3);
          const messageCounts: number[] = [];
          for (const child of children) {
            expect(child.kind).toBe("delegate");
            expect(yield* runs.list(child.id)).toEqual([]);
            const { history } = yield* session.readTranscriptPage({
              sessionID: child.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            });
            messageCounts.push(history.length);
            for (const { info } of history)
              if (info.role === "user") expect(info.model).toEqual(parentModel);
          }
          expect(messageCounts.sort((a, b) => a - b)).toEqual([
            2,
            roundCount * 2,
            roundCount * 2,
          ]);
          expect(summaryPrompt).not.toBe("");
          const tool = (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool");
          expect(tool?.state).toMatchObject({
            status: "completed",
            metadata: {
              preparedArgs: { round: roundCount, topic },
            },
          });
          const allSpans = traceSpans(tool?.state.metadata?.trace);
          const phases = allSpans.filter(
            (span) => span.name === "Workflow.phase",
          );
          expect(phases).toHaveLength(roundCount + 1);
          const spans = allSpans.filter(
            (span) => span.name === "Workflow.agent",
          );
          for (const [index, span] of spans.entries())
            expect(span.parentSpanId).toBe(
              phases[Math.floor(index / 2)]!.spanId,
            );
          expect([...(tool?.childSessionIds ?? [])].sort()).toEqual(
            children.map((child) => child.id).sort(),
          );
          expect(spans).toHaveLength(roundCount * 2 + 1);
          expect(
            spans.slice(0, roundCount * 2).map((span) => span.spanId),
          ).toEqual(liveSpanIds);
          expect(new Set(spans.map((span) => span.spanId)).size).toBe(
            roundCount * 2 + 1,
          );
          expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
          expect(
            children
              .map(
                (child) =>
                  spans.filter((span) =>
                    span.attributes.some(
                      (attribute) =>
                        attribute.key === "openchart.session.id" &&
                        attribute.value.stringValue === child.id,
                    ),
                  ).length,
              )
              .sort((a, b) => a - b),
          ).toEqual([1, roundCount, roundCount]);
          for (let turn = 0; turn < spans.length; turn++) {
            const span = spans[turn]!;
            expect(span.name).toBe("Workflow.agent");
            expect(span.status.code).toBe(1);
            expect(span.attributes).toContainEqual({
              key: "openchart.label",
              value: {
                stringValue:
                  turn === roundCount * 2
                    ? "Summary"
                    : `${turn % 2 === 0 ? "Affirmative" : "Negative"} · round ${Math.floor(turn / 2) + 1}`,
              },
            });
            if (turn > 0)
              expect(BigInt(span.startTimeUnixNano)).toBeGreaterThanOrEqual(
                BigInt(spans[turn - 1]!.endTimeUnixNano),
              );
          }
          if (tool?.state.status !== "completed")
            throw new Error("Expected a completed debate");
          const output = Schema.decodeUnknownSync(
            Schema.Struct({
              type: Schema.Literal("json"),
              value: Schema.Struct({
                result: Schema.Struct({
                  topic: Schema.String,
                  summary: Schema.Struct({
                    sessionId: Schema.String,
                    output: Schema.String,
                  }),
                  rounds: Schema.Array(
                    Schema.Struct({
                      round: Schema.Number,
                      affirmative: Schema.Struct({
                        sessionId: Schema.String,
                        output: Schema.String,
                      }),
                      negative: Schema.Struct({
                        sessionId: Schema.String,
                        output: Schema.String,
                      }),
                    }),
                  ),
                }),
              }),
            }),
          )(tool.state.output).value.result;
          expect(output.summary.output).toBe("Balanced debate summary");
          expect(children.map((child) => child.id)).toContain(
            output.summary.sessionId,
          );
          expect(
            output.rounds.flatMap((round) => [
              round.affirmative.sessionId,
              round.negative.sessionId,
            ]),
          ).not.toContain(output.summary.sessionId);
          expect(
            output.rounds
              .map((round) => [round.affirmative.output, round.negative.output])
              .flat(),
          ).toEqual(calls);
          expect(
            new Set(
              output.rounds.flatMap((round) => [
                round.affirmative.sessionId,
                round.negative.sessionId,
              ]),
            ).size,
          ).toBe(2);
        }).pipe(Effect.provideService(Models.Service, f.services)),
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);

test("continuations reject unowned Sessions and serialize concurrent turns with their own answers", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const f = fixture(async (input) => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return answer(`Reply: ${userText(input)}`);
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, root } = yield* f.setup;
        const input: AgentPromptInput = {
          ...prompt,
          parts: [{ type: "text", text: "Opening" }],
        };
        const rootRun = yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "host",
          input,
        });
        const invocation = { rootRunID: rootRun.id, sessionID: root.id, input };
        const host = yield* makeWorkflowHost(invocation, executeInvocation, {
          concurrency: 5,
        });
        const otherHost = yield* makeWorkflowHost(
          invocation,
          executeInvocation,
          { concurrency: 5 },
        );
        const foreign = yield* otherHost.agent(input, () => Effect.void);
        const definition = defineWorkflow({
          description: "Exercise Session ownership and serialization",
          args: Schema.Struct({}),
          run: () =>
            Effect.gen(function* () {
              const first = yield* agent({
                ...input,
                workspaceId: "wsp_child",
              });
              for (const sessionId of [root.id, foreign.sessionId, "missing"]) {
                expect(
                  yield* agent(input, { sessionId }).pipe(Effect.flip),
                ).toMatchObject({
                  _tag: "Workflow.SessionNotOwned",
                  sessionId,
                });
              }
              expect(calls).toBe(2);
              const followups = ["First", "Second", "Third"];
              const replies = yield* parallel(
                followups.map((text) =>
                  agent(
                    {
                      ...input,
                      workspaceId: undefined,
                      parts: [{ type: "text", text }],
                    },
                    { sessionId: first.sessionId },
                  ),
                ),
              );
              expect(replies).toEqual(
                followups.map((text) => ({
                  status: "success",
                  value: {
                    sessionId: first.sessionId,
                    output: `Reply: ${text}`,
                  },
                })),
              );
              return first;
            }),
        });
        yield* run(definition, {}).pipe(
          Effect.provideService(Workflow.Service, host),
        );
        expect(maximum).toBe(1);
        expect(calls).toBe(5);
        const children = (yield* session.list({ parentId: root.id, limit: 20 }))
          .items;
        expect(children).toHaveLength(2);
        const own = children.find((child) => child.id !== foreign.sessionId)!;
        const history = (yield* session.readTranscriptPage({
          sessionID: own.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history;
        expect(history).toHaveLength(8);
        const home = yield* Home;
        expect(
          history.flatMap((message) =>
            message.info.role === "assistant" ? [message.info.path.cwd] : [],
          ),
        ).toEqual([
          path.join(home.root, "wsp_child"),
          path.join(home.root, "wsp_workflow"),
          path.join(home.root, "wsp_workflow"),
          path.join(home.root, "wsp_workflow"),
        ]);
        expect(
          history
            .map((message) => message.info)
            .filter((info) => info.role === "user")
            .map((user) => user.workspaceId),
        ).toEqual([
          "wsp_child",
          input.workspaceId,
          input.workspaceId,
          input.workspaceId,
        ]);
        expect(
          (yield* session.readTranscriptPage({
            sessionID: foreign.sessionId,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history,
        ).toHaveLength(2);
        expect(
          (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history,
        ).toEqual([]);
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test("cancelling a continued Session joins its active turn and never starts queued turns", async () => {
  const ready = Deferred.makeUnsafe<void>();
  let continuations = 0;
  let aborted = false;
  const f = fixture(async (input) => {
    if (userText(input) === "Opening") return answer("Opening answer");
    continuations++;
    return new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        input.abortSignal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            controller.error(new Error("Cancelled"));
          },
          { once: true },
        );
        Deferred.doneUnsafe(ready, Effect.void);
      },
    });
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, root } = yield* f.setup;
        const input: AgentPromptInput = {
          ...prompt,
          parts: [{ type: "text", text: "Opening" }],
        };
        const rootRun = yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "cancel-continued",
          input,
        });
        const host = yield* makeWorkflowHost(
          { rootRunID: rootRun.id, sessionID: root.id, input },
          executeInvocation,
          { concurrency: 5 },
        );
        const definition = defineWorkflow({
          description: "Cancel active and queued turns on one Session",
          args: Schema.Struct({}),
          run: () =>
            Effect.gen(function* () {
              const first = yield* agent(input);
              return yield* parallel(
                [1, 2, 3].map((turn) =>
                  agent(
                    {
                      ...input,
                      parts: [{ type: "text", text: `Continue ${turn}` }],
                    },
                    { sessionId: first.sessionId },
                  ),
                ),
              );
            }),
        });
        const traces: Schema.JsonObject[] = [];
        const fiber = yield* run(
          definition,
          {},
          () => Effect.void,
          (trace) =>
            Effect.sync(() => {
              traces.push(trace);
            }),
        ).pipe(Effect.provideService(Workflow.Service, host), Effect.forkChild);
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
        expect(aborted).toBe(true);
        expect(continuations).toBe(1);
        const children = (yield* session.list({ parentId: root.id, limit: 20 }))
          .items;
        expect(children).toHaveLength(1);
        const history = (yield* session.readTranscriptPage({
          sessionID: children[0]!.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history;
        expect(history).toHaveLength(4);
        expect(history.at(-1)?.info).toMatchObject({
          role: "assistant",
          error: { name: "MessageAbortedError" },
          time: { completed: expect.any(Number) },
        });
        for (const trace of traces) traceSpans(trace, true);
        const finalSpans = traceSpans(traces.at(-1));
        expect(finalSpans).toHaveLength(5);
        expect(
          finalSpans.filter((span) =>
            span.attributes.some(
              (attribute) =>
                attribute.key === "openchart.cancelled" &&
                attribute.value.boolValue === true,
            ),
          ),
        ).toHaveLength(4);
      }).pipe(Effect.provideService(Models.Service, f.services), Effect.scoped),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test.each([
  ["intent", "research"],
  ["intent", "summary"],
  ["intent", "child approval"],
  ["intent", "root reply"],
  ["model", "research"],
  ["model", "summary"],
  ["model", "child approval"],
  ["model", "root reply"],
  ["model", "workflow approval"],
] as const)(
  "%s cancellation during %s joins children before the root terminates",
  async (entry, phase) => {
    let active = 0;
    let aborted = 0;
    let modelInvocation = false;
    const ready = Deferred.makeUnsafe<void>();
    const f = fixture(
      async (input) => {
        const text = userText(input);
        if (text === "Continue after cancellation") return answer("Continued");
        if (
          entry === "model" &&
          !text.startsWith("Research ") &&
          !text.startsWith("Synthesize ") &&
          !modelInvocation
        ) {
          modelInvocation = true;
          return [
            {
              type: "tool-input-start",
              id: "model-workflow",
              toolName: "workflow",
            },
            { type: "tool-input-end", id: "model-workflow" },
            {
              type: "tool-call",
              toolCallId: "model-workflow",
              toolName: "workflow",
              input: JSON.stringify({
                workflow: "default:workflows/best-of-n.workflow.ts",
                args: { n: 3, question: "Question" },
              }),
            },
            {
              ...finish,
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ];
        }
        if (phase === "child approval" && text.startsWith("Research "))
          return [
            { type: "tool-input-start", id: "echo", toolName: "echo" },
            { type: "tool-input-end", id: "echo" },
            {
              type: "tool-call",
              toolCallId: "echo",
              toolName: "echo",
              input: JSON.stringify({ text: "Child approval" }),
            },
            {
              ...finish,
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ];
        if (
          (phase === "summary" || phase === "root reply") &&
          text.startsWith("Research ")
        )
          return answer("Research completed");
        if (phase === "root reply" && text.startsWith("Synthesize "))
          return answer("Summary completed");
        expect(
          text.startsWith(
            phase === "research"
              ? "Research "
              : phase === "summary"
                ? "Synthesize "
                : "ROOT_ONLY",
          ),
        ).toBe(true);
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "Working",
            });
            input.abortSignal?.addEventListener(
              "abort",
              () => {
                aborted++;
                controller.error(new Error("Cancelled"));
              },
              { once: true },
            );
            active++;
            if (active === (phase === "research" ? 3 : 1))
              Deferred.doneUnsafe(ready, Effect.void);
          },
        });
      },
      phase === "workflow approval"
        ? "ask"
        : entry === "model"
          ? "allow"
          : "deny",
      phase === "child approval" ? "ask" : "allow",
    );
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          const permission = yield* Permission.Service;
          const execution = yield* SessionRunCoordinator.make({
            drain: (sessionID: string) => runner.run({ sessionID }),
          });
          const input =
            entry === "intent"
              ? prompt
              : {
                  ...prompt,
                  parts: prompt.parts.filter((part) => part.type === "text"),
                };
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "cancel",
            input,
          });
          yield* execution.wake(root.id);
          const approval = phase.endsWith("approval");
          if (approval) {
            yield* Effect.promise(() =>
              expect
                // Workspace programs are type-checked before approvals appear.
                .poll(() => f.runtime.runPromise(permission.list(root.id)), {
                  timeout: 10_000,
                })
                .toHaveLength(phase === "child approval" ? 3 : 1),
            );
          } else yield* Deferred.await(ready);
          // The public coordinator must join cleanup even for simultaneous stops.
          yield* Effect.all(
            [execution.interrupt(root.id), execution.interrupt(root.id)],
            { concurrency: "unbounded" },
          );
          yield* execution.interrupt(root.id);
          expect(yield* execution.active).toEqual(new Set());
          expect(yield* permission.list()).toEqual([]);
          expect(aborted).toBe(approval ? 0 : phase === "research" ? 3 : 1);
          expect((yield* runs.list(root.id))[0]?.status).toBe("stop");
          const children = (yield* session.list({
            parentId: root.id,
            limit: 20,
          })).items;
          expect(children).toHaveLength(
            phase === "workflow approval"
              ? 0
              : phase === "research" || phase === "child approval"
                ? 3
                : 4,
          );
          let cancelled = 0;
          for (const child of children) {
            const history = (yield* session.readTranscriptPage({
              sessionID: child.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            })).history;
            const last = history.at(-1)?.info;
            assertExists(
              last,
              "Every started child must have terminal history",
            );
            expect(last).toMatchObject({
              role: "assistant",
              time: { completed: expect.any(Number) },
            });
            if (last.role === "assistant" && last.error) {
              expect(last.error.name).toBe("MessageAbortedError");
              cancelled++;
            }
            expect(yield* runs.list(child.id)).toEqual([]);
            for (const part of history.flatMap((message) => message.parts)) {
              if (part.type === "tool")
                expect(["pending", "running"]).not.toContain(part.state.status);
            }
          }
          expect(cancelled).toBe(
            phase === "root reply" || phase === "workflow approval"
              ? 0
              : phase === "summary"
                ? 1
                : 3,
          );
          const tools = (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool");
          expect(tools).toHaveLength(1);
          expect(tools[0]?.state.status).toBe(
            phase === "root reply" ? "completed" : "error",
          );
          expect(tools[0]?.state.metadata).not.toHaveProperty("workflowPartId");
          if (phase === "workflow approval") {
            expect(tools[0]?.state.metadata?.trace).toBeUndefined();
          } else {
            const spans = traceSpans(tools[0]?.state.metadata?.trace);
            expect(spans).toHaveLength(
              children.length +
                1 +
                (phase === "research" || phase === "child approval" ? 1 : 2),
            );
            expect(
              spans.every((span) => BigInt(span.endTimeUnixNano) > 0n),
            ).toBe(true);
            expect(
              spans.filter((span) =>
                span.attributes.some(
                  (attribute) =>
                    attribute.key === "openchart.cancelled" &&
                    attribute.value.boolValue === true,
                ),
              ),
            ).toHaveLength(
              cancelled +
                (phase === "research" || phase === "child approval"
                  ? 2
                  : phase === "summary"
                    ? 1
                    : 0),
            );
          }
          const next = yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "after-cancellation",
            input: {
              ...prompt,
              parts: [{ type: "text", text: "Continue after cancellation" }],
            },
          });
          yield* runner.run({ sessionID: root.id });
          yield* execution.interrupt(root.id);
          expect(
            (yield* runs.list(root.id)).find((run) => run.id === next.id)
              ?.status,
          ).toBe("completed");
          expect(
            (yield* session.list({ parentId: root.id, limit: 20 })).items,
          ).toHaveLength(children.length);
          expect(
            (yield* session.readTranscriptPage({
              sessionID: root.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            })).history
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool"),
          ).toHaveLength(1);
        }).pipe(
          Effect.provideService(Models.Service, f.services),
          Effect.scoped,
        ),
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);

test.each([
  "default:workflows/unknown.workflow.ts",
  "default:workflows/best-of-n.workflow.ts",
  "default:workflows/multi-turn-debate.workflow.ts",
])(
  "invalid %s invocation records one failed tool without starting children",
  async (workflow) => {
    const f = fixture(async () => answer("The workflow could not execute"));
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "invalid",
            input: {
              ...prompt,
              parts: [{ type: "workflow", workflow, args: {} }],
            },
          });
          yield* runner.run({ sessionID: root.id });
          expect(
            (yield* session.list({ parentId: root.id, limit: 20 })).items,
          ).toEqual([]);
          const parts = (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          })).history.flatMap((message) => message.parts);
          const tool = parts.find((part) => part.type === "tool");
          assertExists(tool, "Invocation failure must be visible");
          expect(tool.state.status).toBe("error");
          expect(parts.filter((part) => part.type === "tool")).toHaveLength(1);
        }).pipe(Effect.provideService(Models.Service, f.services)),
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);

test("workspace type errors become failed ToolParts before creating child Sessions", async () => {
  let modelCalls = 0;
  const f = fixture(async (input) => {
    modelCalls++;
    expect(JSON.stringify(input.prompt)).toContain("TS2339");
    return answer("The workflow needs a type fix");
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        const { root: home } = yield* Home;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          path.join(home, "wsp_workflow/invalid.workflow.ts"),
          `import { defineWorkflow, Schema, Effect, agent, textPrompt } from "@openchart/workflow";
export default defineWorkflow({
  description: "Bad code after a model call",
  args: Schema.Struct({ question: Schema.String }),
  run: ({ question }, { parentPrompt }) => Effect.gen(function* () {
    const result = yield* agent(textPrompt(question, parentPrompt.model, parentPrompt.agent));
    return result.output.missing;
  }),
});`,
        );
        yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "type-error",
          input: {
            ...prompt,
            parts: [
              {
                type: "workflow",
                workflow: "workspace:invalid.workflow.ts",
                args: { question: "Research" },
              },
            ],
          },
        });
        yield* runner.run({ sessionID: root.id });
        expect(
          (yield* session.list({ parentId: root.id, limit: 10 })).items,
        ).toEqual([]);
        const { history } = yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: 10,
        });
        const tool = history
          .flatMap(({ parts }) => parts)
          .find((part) => part.type === "tool");
        expect(tool?.state).toMatchObject({
          status: "error",
          error: expect.stringContaining(
            "invalid.workflow.ts(7,26): error TS2339",
          ),
        });
        expect(modelCalls).toBe(1);
        expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test("one failed researcher is isolated and the summarizer receives its failure alongside successful answers", async () => {
  let summary = "";
  const f = fixture(async (input) => {
    const text = userText(input);
    if (text.startsWith("Research attempt 2"))
      return [
        { type: "error", error: new Error("Research source unavailable") },
      ];
    if (text.startsWith("Research ")) return answer("Useful evidence");
    if (text.startsWith("Synthesize ")) {
      summary = text;
      return answer("Partial synthesis");
    }
    expect(workflowResult(input).childSessionIds).toHaveLength(4);
    return answer("Completed with one failed researcher");
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "partial",
          input: prompt,
        });
        yield* runner.run({ sessionID: root.id });
        expect(summary).toContain("Research source unavailable");
        expect(summary).toContain("Useful evidence");
        expect(summary).toContain('"status":"error"');
        expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
        const tool = (yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool");
        const spans = traceSpans(tool?.state.metadata?.trace);
        expect(spans).toHaveLength(7);
        expect(spans.filter((span) => span.status.code === 2)).toHaveLength(1);
        expect(spans.filter((span) => span.status.code === 1)).toHaveLength(6);
        expect(
          (yield* session.list({ parentId: root.id, limit: 20 })).items,
        ).toHaveLength(4);
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test.each([CODEX, CLAUDE_CODE])(
  "%s workspace workflow branches on structured results and changes format across continued turns",
  async (providerID) => {
    const childCalls: LanguageModelV4CallOptions[] = [];
    const f = fixture(async (input) => {
      const text = userText(input);
      if (!text.startsWith("STRUCTURED_")) return answer("Workflow complete");
      childCalls.push(input);
      if (text.startsWith("STRUCTURED_LOOP:"))
        return answer(
          JSON.stringify({
            done: text.endsWith(":2"),
            round: Number(text.at(-1)),
          }),
        );
      if (text === "STRUCTURED_SWITCH") return answer('{"summary":"Verified"}');
      return answer("Plain final answer");
    });
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          const home = yield* Home;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            path.join(home.root, "wsp_workflow", "structured.workflow.ts"),
            `
import { agent, defineWorkflow, Effect, Schema, textPrompt, type AgentResult } from "@openchart/workflow";
export default defineWorkflow({
  description: "Structured loop",
  args: Schema.Struct({}),
  run: (_, {parentPrompt}) => Effect.gen(function* () {
    const Review = Schema.Struct({done: Schema.Boolean, round: Schema.Int});
    let review: AgentResult<typeof Review.Type> | undefined;
    for (let round = 1; round <= 3; round++) {
      review = yield* agent(textPrompt("STRUCTURED_LOOP:" + round, parentPrompt.model, parentPrompt.agent), {
        schema: Review, sessionId: review?.sessionId,
      });
      if (review.output.done) break;
    }
    if (!review) return yield* Effect.fail(new Error("No review was produced"));
    const switched = yield* agent(textPrompt("STRUCTURED_SWITCH", parentPrompt.model, parentPrompt.agent), {
      schema: Schema.Struct({summary: Schema.String}), sessionId: review.sessionId,
    });
    const plain = yield* agent(textPrompt("STRUCTURED_PLAIN", parentPrompt.model, parentPrompt.agent), {
      sessionId: review.sessionId,
    });
    return {review, switched, plain};
  }),
});
`,
          );
          yield* runs.enqueue({
            sessionID: root.id,
            sessionIntentID: "structured-loop",
            input: {
              ...prompt,
              model: { providerID, modelID: TIER4 },
              parts: [
                {
                  type: "workflow",
                  workflow: "workspace:structured.workflow.ts",
                  args: {},
                },
              ],
            },
          });
          yield* runner.run({ sessionID: root.id });
          expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
          const children = (yield* session.list({
            parentId: root.id,
            limit: 10,
          })).items;
          expect(children).toHaveLength(1);
          const childId = children[0]!.id;
          expect(childCalls).toHaveLength(4);
          for (const call of childCalls.slice(0, 2))
            expect(call.responseFormat).toMatchObject({
              type: "json",
              schema: { type: "object", required: ["done", "round"] },
            });
          expect(childCalls[2]!.responseFormat).toMatchObject({
            type: "json",
            schema: { required: ["summary"] },
          });
          expect(childCalls[3]!.responseFormat).toBeUndefined();
          const childHistory = (yield* session.readTranscriptPage({
            sessionID: childId,
            turnLimit: 10,
          })).history;
          const requests = childHistory.flatMap(({ info }) =>
            info.role === "assistant" ? [info.request] : [],
          );
          expect(requests).toHaveLength(4);
          expect(requests[0]?.outputSchema).toMatchObject({
            required: ["done", "round"],
          });
          expect(requests[2]?.outputSchema).toMatchObject({
            required: ["summary"],
          });
          expect(requests[3]?.outputSchema).toBeUndefined();
          const history = (yield* session.readTranscriptPage({
            sessionID: root.id,
            turnLimit: 10,
          })).history;
          const tool = history
            .flatMap(({ parts }) => parts)
            .find((part) => part.type === "tool");
          expect(tool?.state).toMatchObject({
            status: "completed",
            output: {
              type: "json",
              value: {
                result: {
                  review: {
                    sessionId: childId,
                    output: { done: true, round: 2 },
                  },
                  switched: {
                    sessionId: childId,
                    output: { summary: "Verified" },
                  },
                  plain: { sessionId: childId, output: "Plain final answer" },
                },
              },
            },
          });
          if (tool?.state.status === "completed")
            expect(traceSpans(tool.state.metadata?.trace)).toHaveLength(4);
        }).pipe(Effect.provideService(Models.Service, f.services)),
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);
