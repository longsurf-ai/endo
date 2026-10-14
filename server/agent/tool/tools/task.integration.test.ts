import { unusedModelSetup } from "@openchart/server/models/models.test-utils";
// Purpose: Exercises Task through real admission, child execution, permissions, SQLite, and AG-UI.

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { Permission } from "@openchart/server/agent/permission";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import {
  projectTree,
  readTree,
} from "@openchart/server/agent/publisher/agui/subagents";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Session } from "@openchart/server/agent/session";
import { SessionRunner } from "@openchart/server/agent/session/runner";
import { SessionRunCoordinator } from "@openchart/server/agent/session/execution/coordinator";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Home } from "@openchart/server/home";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { Models } from "@openchart/server/models";
import { workspaceStore } from "@openchart/server/resources/workspace/store";
import { makeRuntime } from "@openchart/server/runtime";
import { assertExists } from "@openchart/utils/assert";
import { Deferred, Effect, FileSystem, Schema, Stream } from "effect";
import path from "node:path";
import { from } from "rxjs";
import { expect, test } from "vitest";

const model = {
  id: "task-test",
  providerID: "openai",
  kind: "language" as const,
  name: "Task test",
  capabilities: { input: { text: true }, output: { text: true } },
};
const prompt: AgentPromptInput = {
  agent: "analyst",
  workspaceId: "wsp_task",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text", text: "ROOT_ONLY" }],
};
const finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> = {
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
function calls(
  ...items: { id: string; tool: string; input: object }[]
): LanguageModelV4StreamPart[] {
  return [
    ...items.flatMap((item): LanguageModelV4StreamPart[] => [
      { type: "tool-input-start", id: item.id, toolName: item.tool },
      { type: "tool-input-end", id: item.id },
      {
        type: "tool-call",
        toolCallId: item.id,
        toolName: item.tool,
        input: JSON.stringify(item.input),
      },
    ]),
    { ...finish, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
  ];
}
const task = (id: string, agent = "worker") => ({
  id,
  tool: "task",
  input: { agent, description: `Task ${id}`, prompt: id },
});
function userText(input: LanguageModelV4CallOptions) {
  return (
    input.prompt
      .filter((message) => message.role === "user")
      .at(-1)
      ?.content.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? ""
  );
}
const hasResult = (input: LanguageModelV4CallOptions) =>
  input.prompt.some((message) => message.role === "tool");

function fixture(
  source: (
    input: LanguageModelV4CallOptions,
    selected: { providerID: string; id: string },
  ) => Promise<
    LanguageModelV4StreamPart[] | ReadableStream<LanguageModelV4StreamPart>
  >,
  taskPermission: Permission.Decision = "allow",
  childPermission: Permission.Decision = "allow",
) {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    profiles: {
      agents: {
        analyst: {
          permission: [
            { action: "task", resource: "*", decision: taskPermission },
            { action: "task", resource: "blocked", decision: "deny" },
          ],
        },
        worker: {
          mode: "primary",
          prompt: "WORKER_PROFILE",
          description: "Independent researcher",
          model: { providerID: "codex", modelID: "tier2" },
          permission: [
            { action: "echo", resource: "*", decision: childPermission },
            { action: "task", resource: "*", decision: "allow" },
          ],
        },
        hidden: { hidden: true, mode: "subagent", prompt: "HIDDEN_PROFILE" },
        blocked: { prompt: "BLOCKED_PROFILE" },
      },
    },
  });
  const services: Models.Interface = {
    ...unusedModelSetup,
    list: () => Effect.succeed([]),
    getModel: (_providerID, id) =>
      Effect.succeed({
        ...model,
        id: id === "tier2" ? "worker-model" : model.id,
      }),
    getLanguage: (selected) =>
      Effect.succeed({
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
                      controller.enqueue({
                        type: "stream-start",
                        warnings: [],
                      });
                      for (const part of result) controller.enqueue(part);
                      controller.close();
                    },
                  }),
          };
        },
      } satisfies LanguageModelV4),
  };
  const setup = Effect.gen(function* () {
    const { root: home } = yield* Home;
    const fs = yield* FileSystem.FileSystem;
    const { db } = yield* Database.Service;
    const workspaceRoot = path.join(home, "wsp_task");
    yield* fs.makeDirectory(workspaceRoot);
    yield* db.transaction((tx) =>
      workspaceStore.insert(tx, {
        id: "wsp_task",
        revision: 1,
        body: { root: workspaceRoot },
      }),
    );
    const session = yield* Session.Service;
    const runs = yield* AgentRunStore.Service;
    const runner = yield* SessionRunner.Service;
    const root = yield* session.create({ title: "Task integration" });
    yield* runs.enqueue({
      sessionID: root.id,
      sessionIntentID: "task-test",
      input: prompt,
    });
    return { session, runs, runner, root };
  });
  return { runtime, services, setup };
}

test("parallel multi-step tasks persist fresh children and live output converges with reconnect", async () => {
  let rootID = "";
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (input, selected) => {
    const text = userText(input);
    if (text === "ROOT_ONLY") {
      const definition = input.tools?.find(
        (tool) => tool.type === "function" && tool.name === "task",
      );
      if (definition?.type !== "function")
        throw new Error("Expected task definition");
      expect(definition?.description).toContain(
        "worker: Independent researcher",
      );
      expect(definition?.description).not.toContain("hidden:");
      expect(definition?.description).toContain("- blocked");
      return hasResult(input)
        ? answer("Parent synthesis")
        : calls(task("alpha"), task("beta"));
    }
    expect(selected.id).toBe("worker-model");
    expect(JSON.stringify(input.prompt)).toContain("WORKER_PROFILE");
    expect(JSON.stringify(input.prompt)).not.toContain("ROOT_ONLY");
    if (!hasResult(input)) {
      started++;
      if (started === 2) release();
      await bothStarted;
      return calls({ id: `echo-${text}`, tool: "echo", input: { text } });
    }
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const tree = yield* readTree(
          yield* Session.Service.use((session) =>
            session.readTranscriptPage({
              sessionID: rootID,
              turnLimit: Number.MAX_SAFE_INTEGER,
            }),
          ),
        );
        const own = [...tree.values()].find(
          (entry) => entry.session.title === `Task ${text}`,
        )!;
        expect(
          own.history.some(
            (message) =>
              message.info.role === "assistant" &&
              message.info.time.completed !== undefined,
          ),
        ).toBe(true);
        const proxy = tree
          .get(rootID)!
          .history.flatMap((message) => message.parts)
          .find(
            (part): part is ToolPart =>
              part.type === "tool" &&
              part.childSessionIds[0] === own.session.id,
          )!;
        expect(proxy.state.status).toBe("running");
        expect(
          projectTree(rootID, tree).lifecycle.filter(
            (event) =>
              event.type === EventType.SUBAGENT_FINISHED &&
              event.subagentRunId === proxy.id,
          ),
        ).toEqual([]);
      }),
    );
    return answer(`Final ${text}`);
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { session, runs, runner, root } = yield* f.setup;
        rootID = root.id;
        const events = yield* Events.Service;
        const stream = yield* events.allBounded(1024);
        const finished = yield* Deferred.make<void>();
        const received: AGUIEvent[] = [];
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
        yield* runner.run({ sessionID: root.id });
        yield* Deferred.await(finished);
        expect((yield* runs.list(root.id))[0]?.status).toBe("completed");
        const tree = yield* readTree(
          yield* Session.Service.use((session) =>
            session.readTranscriptPage({
              sessionID: root.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            }),
          ),
        );
        expect(tree.size).toBe(3);
        const proxies = tree
          .get(root.id)!
          .history.flatMap((message) => message.parts)
          .filter((part): part is ToolPart => part.type === "tool");
        expect(proxies).toHaveLength(2);
        expect(
          new Set(proxies.map((part) => part.childSessionIds[0])).size,
        ).toBe(2);
        for (const proxy of proxies) {
          expect(proxy.state).toMatchObject({
            status: "completed",
            output: { type: "text", value: `Final ${proxy.callID}` },
          });
          const child = tree.get(proxy.childSessionIds[0]!)!;
          expect(child.session).toMatchObject({
            parentId: root.id,
            kind: "delegate",
            title: `Task ${proxy.callID}`,
          });
          expect(child.history[0]?.info).toMatchObject({
            role: "user",
            agent: "worker",
            workspaceId: "wsp_task",
          });
          expect(
            child.history.filter(
              (message) => message.info.role === "assistant",
            ),
          ).toHaveLength(2);
          expect(yield* runs.list(child.session.id)).toEqual([]);
          expect(
            received
              .filter(
                (event) =>
                  ((event.type === EventType.TOOL_CALL_START ||
                    event.type === EventType.TOOL_CALL_RESULT) &&
                    event.toolCallId === proxy.callID) ||
                  ((event.type === EventType.SUBAGENT_STARTED ||
                    event.type === EventType.SUBAGENT_FINISHED ||
                    event.type === EventType.SUBAGENT_ERROR) &&
                    event.subagentRunId === proxy.id),
              )
              .map((event) => event.type),
          ).toEqual([
            EventType.TOOL_CALL_START,
            EventType.SUBAGENT_STARTED,
            EventType.SUBAGENT_FINISHED,
            EventType.TOOL_CALL_RESULT,
          ]);
        }
        const client = new (class extends AbstractAgent {
          /** Replays actual committed events through the community reducer. @example client.runAgent(); */
          run() {
            return from(received);
          }
        })({ threadId: root.id, initialState: { messageInfo: {} } });
        yield* Effect.promise(() => client.runAgent());
        // Parallel descendants interleave on the wire; each invocation's visible
        // message order and content must match its fresh bootstrap projection.
        for (const id of [undefined, ...proxies.map((proxy) => proxy.id)])
          expect(
            client.messages.filter((message) => message.subagentRunId === id),
          ).toEqual(
            projectTree(root.id, tree).messages.filter(
              (message) => message.subagentRunId === id,
            ),
          );
        expect(client.state).toMatchObject({
          messageInfo: projectTree(root.id, tree).messageInfo,
        });
        expect(
          (yield* session.list({ parentId: root.id, limit: 10 })).items,
        ).toHaveLength(2);
      }).pipe(Effect.provideService(Models.Service, f.services), Effect.scoped),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test("tasks can nest and explicitly call hidden profiles", async () => {
  const f = fixture(async (input) => {
    const text = userText(input);
    if (hasResult(input)) return answer(`Final ${text}`);
    if (text === "ROOT_ONLY") return calls(task("outer"));
    if (text === "outer") return calls(task("inner", "hidden"));
    return answer("Nested answer");
  });
  try {
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const { runner, root } = yield* f.setup;
        yield* runner.run({ sessionID: root.id });
        const tree = yield* readTree(
          yield* Session.Service.use((session) =>
            session.readTranscriptPage({
              sessionID: root.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            }),
          ),
        );
        expect(tree.size).toBe(3);
        const lifecycle = projectTree(root.id, tree).lifecycle;
        expect(lifecycle.map((event) => event.type)).toEqual([
          EventType.SUBAGENT_STARTED,
          EventType.SUBAGENT_STARTED,
          EventType.SUBAGENT_FINISHED,
          EventType.SUBAGENT_FINISHED,
        ]);
        expect(lifecycle[1]).toMatchObject({
          parentSubagentRunId: lifecycle[0]!.subagentRunId,
        });
      }).pipe(Effect.provideService(Models.Service, f.services)),
    );
  } finally {
    await f.runtime.dispose();
  }
});

test.each(["task approval", "child approval", "streaming"] as const)(
  "cancellation during %s joins children and leaves terminal reconnect state",
  async (phase) => {
    const ready = Deferred.makeUnsafe<void>();
    let aborted = 0;
    const f = fixture(
      async (input) => {
        if (userText(input) === "ROOT_ONLY") return calls(task("child"));
        if (phase === "child approval")
          return calls({ id: "echo", tool: "echo", input: { text: "child" } });
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
            Deferred.doneUnsafe(ready, Effect.void);
          },
        });
      },
      phase === "task approval" ? "ask" : "allow",
      phase === "child approval" ? "ask" : "allow",
    );
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const { session, runs, runner, root } = yield* f.setup;
          const permissions = yield* Permission.Service;
          const execution = yield* SessionRunCoordinator.make({
            drain: (sessionID: string) => runner.run({ sessionID }),
          });
          yield* execution.wake(root.id);
          if (phase === "streaming") yield* Deferred.await(ready);
          else
            yield* Effect.promise(() =>
              expect
                .poll(() => f.runtime.runPromise(permissions.list(root.id)))
                .toHaveLength(1),
            );
          if (phase === "child approval") {
            const requests = yield* permissions.list(root.id);
            expect(requests[0]?.action).toBe("echo");
            expect(requests[0]?.sessionID).not.toBe(root.id);
          }
          yield* execution.interrupt(root.id);
          expect(yield* execution.active).toEqual(new Set());
          expect(yield* permissions.list()).toEqual([]);
          expect((yield* runs.list(root.id))[0]?.status).toBe("stop");
          expect(aborted).toBe(phase === "streaming" ? 1 : 0);
          const tree = yield* readTree(
            yield* Session.Service.use((session) =>
              session.readTranscriptPage({
                sessionID: root.id,
                turnLimit: Number.MAX_SAFE_INTEGER,
              }),
            ),
          );
          expect(tree.size).toBe(phase === "task approval" ? 1 : 2);
          for (const transcript of tree.values()) {
            const last = transcript.history.at(-1)?.info;
            assertExists(last, "Every started invocation has terminal history");
            expect(last).toMatchObject({
              role: "assistant",
              time: { completed: expect.any(Number) },
            });
            for (const part of transcript.history.flatMap(
              (message) => message.parts,
            ))
              if (part.type === "tool")
                expect(["pending", "running"]).not.toContain(part.state.status);
          }
          const lifecycle = projectTree(root.id, tree).lifecycle;
          expect(lifecycle.map((event) => event.type)).toEqual(
            phase === "task approval"
              ? []
              : [EventType.SUBAGENT_STARTED, EventType.SUBAGENT_ERROR],
          );
          expect(
            (yield* session.list({ parentId: root.id, limit: 10 })).items,
          ).toHaveLength(phase === "task approval" ? 0 : 1);
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
