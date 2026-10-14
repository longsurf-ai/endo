// Purpose: Proves tRPC admission executes the real prompt loop and commits its transcript.

import { temporaryHome } from "@openchart/server/home.test-utils";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AvailableModel } from "@openchart/models/model-provider";
import { mockModels } from "@openchart/server/models/models.test-utils";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Session } from "@openchart/server/agent/session";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { simulateReadableStream } from "ai";
import { Effect } from "effect";
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@openchart/server/contract";

import { makeRuntime } from "@openchart/server/runtime";
import { agentRouter } from "./router";

const model = AvailableModel.parse({
  kind: "language",
  providerID: "openai",
  id: "test-model",
  name: "Test",
  tier: 1,
  capabilities: {
    toolcall: true,
    input: { text: true },
    output: { text: true },
  },
  limit: { context: 200_000, output: 16_384 },
});
const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const answer: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: "Connected." },
  { type: "text-end", id: "answer" },
  finish,
];

afterEach(() => vi.restoreAllMocks());

function fixture(doStream: LanguageModelV4["doStream"]) {
  const language: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: model.providerID,
    modelId: model.id,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream,
  };
  const { service, create, dispose } = mockModels(model, language);
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const caller = agentRouter.createCaller({ runtime });
  const prompt = (sessionID: string, sessionIntentID: string) =>
    caller.prompt({
      sessionID,
      sessionIntentID,
      input: {
        agent: "analyst",
        model: { providerID: "codex" as const, modelID: "tier1" as const },
        parts: [{ type: "text", text: "Hello" }],
      },
    });
  const transcript = (sessionID: string) =>
    runtime.runPromise(
      Session.Service.use((session) =>
        session.listMessages({ sessionID, limit: 100 }),
      ),
    );
  const status = (id: Parameters<AgentRunStore.Interface["get"]>[0]) =>
    runtime.runPromise(
      AgentRunStore.Service.use((store) => store.get(id)).pipe(
        Effect.map((run) => run?.status),
      ),
    );
  const session = () =>
    runtime.runPromise(
      Session.Service.use((session) => session.create({ title: "Test" })),
    );
  return {
    runtime,
    service,
    dispose,
    create,
    prompt,
    transcript,
    status,
    session,
  };
}

test("resolves bound Sessions without starting execution or creating on reads", async () => {
  const doStream = vi.fn<LanguageModelV4["doStream"]>();
  const { runtime } = fixture(doStream);
  const caller = agentRouter.createCaller({ runtime });
  const key = "feature:slot";
  try {
    expect(await caller.getSessionByBinding({ key })).toBeNull();
    expect((await caller.listSessions({})).items).toEqual([]);
    const session = await caller.getOrCreateBoundSession({
      kind: "chat",
      key,
      title: "Feature session",
    });
    expect(
      await caller.getOrCreateBoundSession({
        kind: "chat",
        key,
        title: "Replacement",
      }),
    ).toEqual(session);
    expect(await caller.getSessionByBinding({ key })).toEqual(session);
    expect((await caller.listSessions({})).items).toEqual([
      { ...session, isActive: false, isUnread: false },
    ]);
    const runs = await runtime.runPromise(
      AgentRunStore.Service.use((store) => store.list(session.id)),
    );
    expect(runs).toEqual([]);
    expect(doStream).not.toHaveBeenCalled();
    await expect(caller.getSessionByBinding({ key: "" })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      },
    );
    await expect(
      caller.getOrCreateBoundSession({ kind: "chat", key: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  } finally {
    await runtime.dispose();
  }
});

test("runs tRPC prompts through tools, continuation, snapshots, and durable completion", async () => {
  const doStream = vi
    .fn<LanguageModelV4["doStream"]>(async () => ({
      stream: simulateReadableStream({ chunks: answer }),
    }))
    .mockImplementationOnce(async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "echo-call", toolName: "echo" },
          {
            type: "tool-input-delta",
            id: "echo-call",
            delta: '{"text":"hello"}',
          },
          { type: "tool-input-end", id: "echo-call" },
          {
            type: "tool-call",
            toolCallId: "echo-call",
            toolName: "echo",
            input: '{"text":"hello"}',
          },
          {
            ...finish,
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ] satisfies LanguageModelV4StreamPart[],
      }),
    }));
  const { runtime, service, dispose, create } = fixture(doStream);
  expect(create).not.toHaveBeenCalled();
  try {
    const session = await runtime.runPromise(
      Session.Service.use((session) => session.create({ title: "Test" })),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.getModel).not.toHaveBeenCalled();
    expect(doStream).not.toHaveBeenCalled();
    const caller = agentRouter.createCaller({ runtime });
    const accepted = await caller.prompt({
      sessionID: session.id,
      sessionIntentID: "intent-1",
      input: {
        agent: "analyst",
        model: { providerID: "codex" as const, modelID: "tier1" as const },
        parts: [{ type: "text", text: "Echo hello, then confirm." }],
      },
    });

    expect(accepted.status).toBe("queued");
    await expect
      .poll(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentRunStore.Service;
            return (yield* store.get(accepted.id))?.status;
          }),
        ),
      )
      .toBe("completed");

    const transcript = await runtime.runPromise(
      Session.Service.use((sessions) =>
        sessions.listMessages({ sessionID: session.id, limit: 100 }),
      ),
    );
    expect(
      transcript.items.filter((item) => item.info.role === "user"),
    ).toHaveLength(1);
    const assistants = transcript.items.filter(
      (item) => item.info.role === "assistant",
    );
    expect(assistants).toHaveLength(2);
    expect(assistants.map((item) => item.info)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finish: "tool-calls" }),
        expect.objectContaining({ finish: "stop" }),
      ]),
    );
    const parts = assistants.flatMap((item) => item.parts);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          childSessionIds: [],
          callID: "echo-call",
          tool: "echo",
          state: expect.objectContaining({
            status: "completed",
            output: { type: "text", value: "echo hello" },
          }),
        }),
        expect.objectContaining({ type: "text", text: "Connected." }),
      ]),
    );
    for (const item of assistants) {
      expect(item.info).toMatchObject({
        request: {
          tools: [
            "echo",
            "workflow",
            "task",
            "resource_read",
            "resource_mutate",
            "resource_search",
            "read_transcript",
            "search_transcript",
            "create_schedule",
          ].map((id) => expect.objectContaining({ id })),
        },
      });
    }
    expect(doStream).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(doStream.mock.calls[1]![0].prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool-result",
              toolCallId: "echo-call",
              output: { type: "text", value: "echo hello" },
            }),
          ]),
        }),
      ]),
    );
  } finally {
    await runtime.dispose();
  }
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("records a provider failure and successfully executes the next admitted prompt", async () => {
  const doStream = vi
    .fn<LanguageModelV4["doStream"]>(async () => ({
      stream: simulateReadableStream({ chunks: answer }),
    }))
    .mockImplementationOnce(async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("Provider unavailable") },
        ] satisfies LanguageModelV4StreamPart[],
      }),
    }));
  const f = fixture(doStream);
  try {
    const session = await f.session();
    const failed = await f.prompt(session.id, "failure");
    await expect.poll(() => f.status(failed.id)).toBe("failed");
    expect((await f.transcript(session.id)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          info: expect.objectContaining({
            role: "assistant",
            error: {
              name: "UnknownError",
              data: { message: "Provider unavailable" },
            },
            time: expect.objectContaining({ completed: expect.any(Number) }),
          }),
        }),
      ]),
    );
    const recovered = await f.prompt(session.id, "recovery");
    await expect.poll(() => f.status(recovered.id)).toBe("completed");
    expect(doStream).toHaveBeenCalledTimes(2);
  } finally {
    await f.runtime.dispose();
  }
});

test("stops a running model request, seals partial transcript, and marks its Run stopped", async () => {
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async (options) => {
    let closed = false;
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of answer.slice(0, 3)) controller.enqueue(part);
          options.abortSignal?.addEventListener(
            "abort",
            () => {
              if (!closed) controller.close();
              closed = true;
            },
            { once: true },
          );
        },
        cancel() {
          closed = true;
        },
      }),
    };
  });
  const f = fixture(doStream);
  try {
    const session = await f.session();
    const accepted = await f.prompt(session.id, "interrupt");
    await expect
      .poll(async () =>
        (await f.transcript(session.id)).items.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "Connected.",
          ),
        ),
      )
      .toBe(true);
    await f.runtime.runPromise(
      SessionExecution.Service.use((execution) =>
        execution.interrupt(session.id),
      ),
    );
    expect(await f.status(accepted.id)).toBe("stop");
    expect(doStream.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
    const assistant = (await f.transcript(session.id)).items.find(
      (message) => message.info.role === "assistant",
    );
    expect(assistant).toMatchObject({
      info: {
        error: { name: "MessageAbortedError" },
        time: { completed: expect.any(Number) },
      },
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "Connected.",
          time: { start: expect.any(Number), end: expect.any(Number) },
        }),
      ]),
    });
    expect(
      await f.runtime.runPromise(
        SessionExecution.Service.use((execution) => execution.active),
      ),
    ).not.toContain(session.id);
  } finally {
    await f.runtime.dispose();
  }
});

test("exports complete prompt part types through the tRPC contract", () => {
  type InputPart =
    inferRouterInputs<AppRouter>["agent"]["prompt"]["input"]["parts"][number];
  type Receipt = inferRouterOutputs<AppRouter>["agent"]["prompt"];
  expectTypeOf<Receipt["status"]>().toEqualTypeOf<
    "queued" | "running" | "completed" | "stop" | "failed"
  >();
  expectTypeOf<
    Extract<InputPart, { type: "file" }>["mime"]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    Extract<InputPart, { type: "workflow" }>["workflow"]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    Extract<
      Extract<InputPart, { type: "context" }>["context"],
      { kind: "quote" }
    >["text"]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    Extract<
      Extract<InputPart, { type: "context" }>["context"],
      { kind: "dig_in" }
    >["quoteText"]
  >().toEqualTypeOf<string>();
});
