// Purpose: Drives the Codex adapter against a scripted app-server through the real AI SDK stream and conformer.
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import { createContinuation } from "@openchart/models/providers/continuation";
import { codex } from "@openchart/models/providers/codex/binding";
import type {
  ProviderQuestionAsk,
  ProviderQuestionReply,
} from "@openchart/models/provider-question";
import { convertPrompt } from "./history";
import { createCodexProvider, type CodexProvider } from "./provider";
import type { ChildProcessLike } from "./rpc";

type Message = Record<string, unknown>;

/** In-memory app-server: answers requests, records them, and lets tests script notifications. */
function fakeCodex() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child = {
    stdin,
    stdout,
    stderr,
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    kill() {
      setImmediate(() => exit(null, "SIGTERM"));
    },
  };
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    for (const listener of listeners.get("exit") ?? []) listener(code, signal);
  };
  const write = (message: Message) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  const requests: Array<{ id: number; method: string; params: Message }> = [];
  const handlers = new Map<string, (params: Message) => unknown>();
  const answers = new Map<number, (message: Message) => void>();
  let counter = 0;
  let serverId = 1000;
  const defaults = (method: string) => {
    switch (method) {
      case "initialize":
        return { userAgent: "fake/0.156.0" };
      case "thread/start":
        return { thread: { id: `thread_${++counter}` } };
      case "turn/start":
        return { turn: { id: `turn_${++counter}` } };
      case "account/read":
        return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
      case "model/list":
        return { data: [], nextCursor: null };
      default:
        return {};
    }
  };
  createInterface({ input: stdin }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    if (typeof message.method === "string" && message.id !== undefined) {
      const method = message.method;
      const params = (message.params ?? {}) as Message;
      requests.push({ id: message.id as number, method, params });
      const handler = handlers.get(method);
      void Promise.resolve(handler ? handler(params) : defaults(method)).then(
        (result) =>
          write({ id: message.id, result: result ?? defaults(method) }),
        (error: Error) =>
          write({
            id: message.id,
            error: { code: -32000, message: error.message },
          }),
      );
      return;
    }
    if (message.method === undefined)
      answers.get(message.id as number)?.(message);
  });
  return {
    spawn: vi.fn((): ChildProcessLike => child as unknown as ChildProcessLike),
    requests,
    /** Overrides one method's response; the handler may schedule notifications. */
    respond: (method: string, handler: (params: Message) => unknown) => {
      handlers.set(method, handler);
    },
    notify: (method: string, params: Message) => write({ method, params }),
    /** Sends a server-to-client request and resolves with the client's answer. */
    ask: (method: string, params: Message) =>
      new Promise<Message>((resolve) => {
        const id = serverId++;
        answers.set(id, resolve);
        write({ id, method, params });
      }),
    crash: () => exit(1, null),
    calls: (method: string) =>
      requests.filter((request) => request.method === method),
  };
}

function owner(event: {
  providerMetadata?: { openchart?: { delegateCallId?: string } };
}): string {
  return event.providerMetadata?.openchart?.delegateCallId ?? "root";
}

function compact(events: ModelStreamEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case "text-delta":
        return [`text-delta:${owner(event)}:${event.text}`];
      case "reasoning-delta":
        return [`reasoning-delta:${owner(event)}:${event.text}`];
      case "tool-call":
        return [`tool-call:${owner(event)}:${event.toolName}`];
      case "tool-result":
        return [`tool-result:${owner(event)}:${event.toolName}`];
      case "tool-error":
        return [`tool-error:${owner(event)}:${event.toolName}`];
      case "start-step":
      case "finish-step":
        return [`${event.type}:${owner(event)}`];
      case "finish":
        return [`finish:${event.finishReason}`];
      default:
        return [];
    }
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function drain(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

const user = (text: string): LanguageModelV4Prompt[number] => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): LanguageModelV4Prompt[number] => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const providers: CodexProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
});

function setup() {
  const fake = fakeCodex();
  const provider = createCodexProvider({
    executable: "/fake/codex",
    spawn: fake.spawn,
  });
  providers.push(provider);
  return { fake, provider, model: provider.languageModel("gpt-test") };
}

/** Scripts one turn: after turn/start is answered, `run` drives notifications. */
function onTurn(
  fake: ReturnType<typeof fakeCodex>,
  run: (thread: string, turn: string) => void | Promise<void>,
) {
  let turns = 0;
  fake.respond("turn/start", (params) => {
    const turn = `turn_${++turns}`;
    setImmediate(() => void run(params.threadId as string, turn));
    return { turn: { id: turn } };
  });
}

const agentMessage = (id: string, text: string) => ({
  type: "agentMessage",
  id,
  text,
});
const completed = (thread: string, turn: string) => ({
  threadId: thread,
  turn: { id: turn, status: "completed" },
});

describe("Codex adapter", () => {
  it("applies binding permissions to every turn and starts fresh when the mode changes", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) =>
      fake.notify("turn/completed", completed(thread, turn)),
    );
    const prompt: LanguageModelV4Prompt = [user("first")];
    for (const permissionMode of [
      "full-access",
      "full-access",
      "ask",
      "auto",
    ] as const) {
      const options = codex.requestOptions({
        cwd: "/workspace",
        tools: {},
        permissionMode,
        askPermission: vi.fn(async () => {}),
      });
      await drain(
        (
          await model.doStream({
            prompt: [...prompt],
            providerOptions: { "codex-app-server": options },
          } as unknown as LanguageModelV4CallOptions)
        ).stream,
      );
      const turn = fake.calls("turn/start").at(-1)!.params;
      expect(turn).toMatchObject({
        approvalPolicy:
          permissionMode === "full-access" ? "never" : "on-request",
        approvalsReviewer: permissionMode === "auto" ? "auto_review" : "user",
        sandboxPolicy:
          permissionMode === "full-access"
            ? { type: "dangerFullAccess" }
            : {
                type: "workspaceWrite",
                writableRoots: ["/workspace"],
                networkAccess: false,
                excludeSlashTmp: true,
                excludeTmpdirEnvVar: true,
              },
      });
      prompt.push(assistant("done"), user(`next ${prompt.length}`));
    }
    const starts = fake.calls("thread/start");
    expect(
      starts.map(({ params }) => [
        params.approvalPolicy,
        params.sandbox,
        params.approvalsReviewer,
      ]),
    ).toEqual([
      ["never", "danger-full-access", "user"],
      ["on-request", "workspace-write", "user"],
      ["on-request", "workspace-write", "auto_review"],
    ]);
    const turns = fake.calls("turn/start");
    expect(turns[1]!.params.threadId).toBe(turns[0]!.params.threadId);
    expect(turns[2]!.params.threadId).not.toBe(turns[1]!.params.threadId);
    expect(turns[3]!.params.threadId).not.toBe(turns[2]!.params.threadId);
  });

  it("streams reasoning and text, then finishes with native usage", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      const scope = { threadId: thread, turnId: turn };
      fake.notify("item/started", {
        ...scope,
        item: { type: "reasoning", id: "r1", summary: [], content: [] },
      });
      fake.notify("item/reasoning/summaryTextDelta", {
        ...scope,
        itemId: "r1",
        delta: "think",
      });
      fake.notify("item/completed", {
        ...scope,
        item: { type: "reasoning", id: "r1", summary: ["think"], content: [] },
      });
      fake.notify("item/agentMessage/delta", {
        ...scope,
        itemId: "m1",
        delta: "Hel",
      });
      fake.notify("item/agentMessage/delta", {
        ...scope,
        itemId: "m1",
        delta: "lo",
      });
      fake.notify("item/completed", {
        ...scope,
        item: agentMessage("m1", "Hello"),
      });
      fake.notify("thread/tokenUsage/updated", {
        ...scope,
        tokenUsage: {
          last: {
            totalTokens: 14,
            inputTokens: 10,
            cachedInputTokens: 4,
            outputTokens: 4,
            reasoningOutputTokens: 1,
          },
        },
      });
      fake.notify("turn/completed", completed(thread, turn));
    });
    const result = streamText({
      model,
      system: "Be brief.",
      messages: [{ role: "user", content: "hi" }],
      providerOptions: {
        "codex-app-server": { cwd: "/workspace", effort: "low" },
      },
      maxRetries: 0,
    });
    const events = await collect(conformProviderStream(result.fullStream));
    expect(compact(events)).toEqual([
      "start-step:root",
      "reasoning-delta:root:think",
      "text-delta:root:Hel",
      "text-delta:root:lo",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(events.find((event) => event.type === "finish-step")).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    expect(fake.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
    ]);
    expect(fake.calls("thread/start")[0]!.params).toMatchObject({
      model: "gpt-test",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      developerInstructions: "Be brief.",
      ephemeral: false,
    });
    expect(fake.calls("turn/start")[0]!.params).toMatchObject({
      input: [{ type: "text", text: "hi" }],
      effort: "low",
      summary: "auto",
      cwd: "/workspace",
    });
  });

  it("maps native tools and MCP media, including computer-use screenshots", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      const scope = { threadId: thread, turnId: turn };
      const exec = {
        type: "commandExecution",
        id: "c1",
        command: "ls",
        cwd: "/w",
        status: "inProgress",
      };
      fake.notify("item/started", { ...scope, item: exec });
      fake.notify("item/completed", {
        ...scope,
        item: {
          ...exec,
          status: "completed",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      });
      const shot = {
        type: "mcpToolCall",
        id: "s1",
        server: "browser",
        tool: "screenshot",
        status: "inProgress",
        arguments: {},
      };
      fake.notify("item/started", { ...scope, item: shot });
      fake.notify("item/completed", {
        ...scope,
        item: {
          ...shot,
          status: "completed",
          result: {
            content: [{ type: "image", data: "AAA", mimeType: "image/png" }],
            _meta: {
              "codex/toolSurface": {
                kind: "computerUse",
                screenshot: { url: "data:image/png;base64,AAA" },
              },
            },
          },
        },
      });
      const click = { ...shot, id: "s2", tool: "click" };
      fake.notify("item/started", { ...scope, item: click });
      fake.notify("item/completed", {
        ...scope,
        item: {
          ...click,
          status: "completed",
          result: {
            content: [{ type: "text", text: "clicked" }],
            _meta: {
              "codex/toolSurface": {
                kind: "browserUse",
                screenshot: { url: "data:image/png;base64,BBB" },
              },
            },
          },
        },
      });
      fake.notify("turn/completed", completed(thread, turn));
    });
    const events = await collect(
      conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "go" }],
          maxRetries: 0,
        }).fullStream,
      ),
    );
    const results = events.filter((event) => event.type === "tool-result");
    expect(results.map((event) => [event.toolName, event.output])).toEqual([
      ["exec", { output: "ok", attachments: [] }],
      [
        "mcp__browser__screenshot",
        {
          output: "",
          attachments: [
            { mime: "image/png", url: "data:image/png;base64,AAA" },
          ],
          computerUse: { title: "Computer use" },
        },
      ],
      [
        "mcp__browser__click",
        {
          output: "clicked",
          attachments: [],
          computerUse: {
            title: "Computer use",
            screenshot: { mime: "image/png", url: "data:image/png;base64,BBB" },
          },
        },
      ],
    ]);
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      toolName: "exec",
      input: { command: "ls", cwd: "/w" },
      providerExecuted: true,
    });
  });

  it("runs OpenChart tools through dynamic tools and restores the exact outcome", async () => {
    const { fake, model } = setup();
    const execute = vi.fn(
      async (input: unknown, options: { toolCallId: string }) => ({
        full: true,
        input,
        toolCallId: options.toolCallId,
      }),
    );
    const tools = {
      search: {
        description: "Search",
        inputSchema: z.object({ q: z.string() }),
        execute,
        toModelOutput: (output: unknown) => ({
          q: (output as { input: { q: string } }).input.q,
        }),
      },
      failing: {
        description: "Fails",
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error("boom");
        },
        toModelOutput: (output: unknown) => output,
      },
    };
    onTurn(fake, async (thread, turn) => {
      const scope = { threadId: thread, turnId: turn };
      const answer = await fake.ask("item/tool/call", {
        ...scope,
        callId: "call_1",
        tool: "search",
        arguments: { q: "AAPL" },
      });
      expect(answer.result).toEqual({
        contentItems: [{ type: "inputText", text: '{"q":"AAPL"}' }],
        success: true,
      });
      const call = {
        type: "dynamicToolCall",
        id: "call_1",
        tool: "search",
        arguments: { q: "AAPL" },
        status: "inProgress",
      };
      fake.notify("item/started", { ...scope, item: call });
      fake.notify("item/completed", {
        ...scope,
        item: { ...call, status: "completed", success: true },
      });
      const failed = await fake.ask("item/tool/call", {
        ...scope,
        callId: "call_2",
        tool: "failing",
        arguments: {},
      });
      expect(failed.result).toEqual({
        contentItems: [{ type: "inputText", text: "boom" }],
        success: false,
      });
      fake.notify("item/completed", {
        ...scope,
        item: {
          type: "dynamicToolCall",
          id: "call_2",
          tool: "failing",
          arguments: {},
          status: "failed",
          success: false,
        },
      });
      fake.notify("item/completed", {
        ...scope,
        item: agentMessage("m1", "done"),
      });
      fake.notify("turn/completed", completed(thread, turn));
    });
    const events = await collect(
      conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "search" }],
          providerOptions: { "codex-app-server": { tools } } as never,
          maxRetries: 0,
        }).fullStream,
      ),
    );
    expect(compact(events)).toEqual([
      "start-step:root",
      "tool-call:root:search",
      "tool-result:root:search",
      "tool-call:root:failing",
      "tool-error:root:failing",
      "text-delta:root:done",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(execute).toHaveBeenCalledWith(
      { q: "AAPL" },
      expect.objectContaining({ toolCallId: "call_1" }),
    );
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      providerExecuted: true,
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
      output: { full: true, input: { q: "AAPL" }, toolCallId: "call_1" },
    });
    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      error: "boom",
    });
    expect(fake.calls("thread/start")[0]!.params.dynamicTools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "search",
        description: "Search",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
      expect.objectContaining({ type: "function", name: "failing" }),
    ]);
  });

  it("nests spawned subagents: child finishes before its proxy, parent output is never held", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      const root = { threadId: thread, turnId: turn };
      const a = { threadId: "child_a", turnId: "turn_a" };
      const b = { threadId: "child_b", turnId: "turn_b" };
      const spawn = (id: string, prompt: string) => ({
        type: "collabAgentToolCall",
        id,
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: thread,
        receiverThreadIds: [] as string[],
        prompt,
        model: "gpt-test",
        agentsStates: {},
      });
      const spawnA = spawn("spawn_a", "review");
      const spawnB = spawn("spawn_b", "test");
      fake.notify("item/started", { ...root, item: spawnA });
      fake.notify("item/started", { ...root, item: spawnB });
      // Both children announce before either spawn names its receiver. The router
      // delivers their events here; the translator holds them until each binds.
      fake.notify("thread/started", {
        thread: { id: "child_a", parentThreadId: thread },
      });
      fake.notify("thread/started", {
        thread: { id: "child_b", parentThreadId: thread },
      });
      fake.notify("item/agentMessage/delta", {
        ...a,
        itemId: "am",
        delta: "A says",
      });
      fake.notify("item/agentMessage/delta", {
        ...b,
        itemId: "bm",
        delta: "B says",
      });
      fake.notify("item/completed", {
        ...root,
        item: {
          ...spawnA,
          status: "completed",
          receiverThreadIds: ["child_a"],
          agentsStates: { child_a: { status: "running" } },
        },
      });
      fake.notify("item/agentMessage/delta", {
        ...root,
        itemId: "pm",
        delta: "parent meanwhile",
      });
      fake.notify("item/completed", {
        ...root,
        item: {
          ...spawnB,
          status: "completed",
          receiverThreadIds: ["child_b"],
          agentsStates: { child_b: { status: "running" } },
        },
      });
      // Activity announcements refer to the already-bound collaboration proxy.
      fake.notify("item/completed", {
        ...root,
        item: {
          type: "subAgentActivity",
          id: "activity_a",
          kind: "started",
          agentThreadId: "child_a",
          agentPath: "/root/reviewer",
        },
      });
      fake.notify("item/completed", {
        ...a,
        item: agentMessage("am", "A says"),
      });
      fake.notify("turn/completed", {
        threadId: "child_a",
        turn: { id: "turn_a", status: "completed" },
      });
      fake.notify("item/completed", {
        ...root,
        item: {
          type: "subAgentActivity",
          id: "activity_a_completed",
          kind: "completed",
          agentThreadId: "child_a",
          agentPath: "/root/reviewer",
        },
      });
      fake.notify("item/completed", {
        ...root,
        item: {
          ...spawnA,
          id: "wait_1",
          tool: "wait",
          status: "completed",
          receiverThreadIds: ["child_a"],
          agentsStates: { child_a: { status: "completed", message: "A says" } },
        },
      });
      fake.notify("item/completed", {
        ...b,
        item: agentMessage("bm", "B says"),
      });
      fake.notify("turn/completed", {
        threadId: "child_b",
        turn: { id: "turn_b", status: "completed" },
      });
      fake.notify("item/completed", {
        ...root,
        item: agentMessage("pm", "parent meanwhile"),
      });
      fake.notify("turn/completed", completed(thread, turn));
    });
    const events = await collect(
      conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "delegate" }],
          maxRetries: 0,
        }).fullStream,
      ),
    );
    expect(compact(events)).toEqual([
      "start-step:root",
      "tool-call:root:spawn_agent",
      "start-step:spawn_a",
      "tool-call:root:spawn_agent",
      "start-step:spawn_b",
      "text-delta:spawn_a:A says",
      "text-delta:root:parent meanwhile",
      "text-delta:spawn_b:B says",
      "finish-step:spawn_a",
      "tool-result:root:spawn_agent",
      "finish-step:spawn_b",
      "tool-result:root:spawn_agent",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(
      events.find((event) => event.type === "tool-call")?.providerMetadata
        ?.openchart,
    ).toEqual({
      openDelegate: {
        description: "Codex subagent",
        prompt: "review",
        agent: "gpt-test",
      },
    });
    expect(
      events
        .filter((event) => event.type === "tool-result")
        .map((event) => event.output),
    ).toEqual([
      { output: "A says", attachments: [] },
      { output: "B says", attachments: [] },
    ]);
  });

  it.each([
    { terminal: "completed", childFirst: true },
    { terminal: "completed", childFirst: false },
    { terminal: "interrupted", childFirst: true },
    { terminal: "interrupted", childFirst: false },
  ])(
    "keeps one activity delegate for $terminal (child first: $childFirst)",
    async ({ terminal, childFirst }) => {
      const { fake, model } = setup();
      onTurn(fake, (thread, turn) => {
        const root = { threadId: thread, turnId: turn };
        const child = { threadId: "child", turnId: "child_turn" };
        const activity = (id: string, kind: string) => {
          const item = {
            type: "subAgentActivity",
            id,
            kind,
            agentThreadId: child.threadId,
            agentPath: "/root/reviewer",
          };
          fake.notify("item/started", { ...root, item });
          fake.notify("item/completed", { ...root, item });
        };
        activity("spawn", "started");
        activity("message", "interacted");
        fake.notify("item/completed", {
          ...child,
          item: agentMessage("answer", "review complete"),
        });
        const childEnd = () =>
          fake.notify("turn/completed", {
            threadId: child.threadId,
            turn: { id: child.turnId, status: terminal },
          });
        if (childFirst) childEnd();
        // The terminal activity has a new item ID, but still names the same thread.
        activity("subagent-completed-child_turn", terminal);
        if (!childFirst) childEnd();
        activity("subagent-completed-child_turn", terminal);
        fake.notify("item/completed", {
          ...root,
          item: agentMessage("parent", "parent continues"),
        });
        fake.notify("turn/completed", completed(thread, turn));
      });
      const events = await collect(
        conformProviderStream(
          streamText({
            model,
            messages: [{ role: "user", content: "delegate" }],
            maxRetries: 0,
          }).fullStream,
        ),
      );
      expect(compact(events)).toEqual([
        "start-step:root",
        "tool-call:root:spawn_agent",
        "start-step:spawn",
        "tool-call:root:agent_interaction",
        "tool-result:root:agent_interaction",
        "text-delta:spawn:review complete",
        "finish-step:spawn",
        `${terminal === "completed" ? "tool-result" : "tool-error"}:root:spawn_agent`,
        "text-delta:root:parent continues",
        "finish-step:root",
        "finish:stop",
      ]);
      expect(
        events.filter(
          (event) =>
            event.type === "tool-call" && event.toolName === "spawn_agent",
        ),
      ).toMatchObject([
        {
          toolCallId: "spawn",
          providerMetadata: { openchart: { openDelegate: expect.any(Object) } },
        },
      ]);
      expect(
        events.filter(
          (event) =>
            (event.type === "tool-result" || event.type === "tool-error") &&
            event.toolName === "spawn_agent",
        ),
      ).toMatchObject([{ toolCallId: "spawn" }]);
    },
  );

  it("projects an adopted child's host call at root until the child binds", async () => {
    const { fake, model } = setup();
    const outcome = { output: "verified", attachments: [] };
    const execute = vi.fn(async () => outcome);
    let reply: Message | undefined;
    onTurn(fake, async (thread, turn) => {
      const root = { threadId: thread, turnId: turn };
      const spawn = (id: string) => ({
        type: "collabAgentToolCall",
        id,
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: thread,
        prompt: "review",
      });
      for (const id of ["spawn_a", "spawn_b"])
        fake.notify("item/started", { ...root, item: spawn(id) });
      for (const id of ["child_a", "child_b"])
        fake.notify("thread/started", {
          thread: { id, parentThreadId: thread },
        });
      // Both threads belong to this request, but neither spawn has named its receiver.
      reply = await fake.ask("item/tool/call", {
        threadId: "child_a",
        turnId: "turn_a",
        callId: "early_call",
        tool: "lookup",
        arguments: {},
      });
      for (const [id, child] of [
        ["spawn_a", "child_a"],
        ["spawn_b", "child_b"],
      ] as const)
        fake.notify("item/completed", {
          ...root,
          item: {
            ...spawn(id),
            status: "completed",
            receiverThreadIds: [child],
          },
        });
      fake.notify("item/completed", {
        threadId: "child_a",
        turnId: "turn_a",
        item: {
          type: "dynamicToolCall",
          id: "early_call",
          tool: "lookup",
          arguments: {},
          status: "completed",
          success: true,
        },
      });
      fake.notify("turn/completed", completed("child_a", "turn_a"));
      fake.notify("turn/completed", completed("child_b", "turn_b"));
      fake.notify("turn/completed", completed(thread, turn));
    });
    const events = await collect(
      conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "review" }],
          providerOptions: {
            "codex-app-server": {
              tools: {
                lookup: {
                  description: "Lookup",
                  inputSchema: z.object({}),
                  execute,
                  toModelOutput: () => "verified",
                },
              },
            },
          } as never,
          maxRetries: 0,
        }).fullStream,
      ),
    );
    expect(reply).toMatchObject({ result: { success: true } });
    expect(execute).toHaveBeenCalledOnce();
    const toolEvents = events.filter(
      (event) =>
        (event.type === "tool-call" || event.type === "tool-result") &&
        event.toolCallId === "early_call",
    );
    expect(toolEvents.map((event) => [event.type, owner(event)])).toEqual([
      ["tool-call", "root"],
      ["tool-result", "root"],
    ]);
    expect(toolEvents.at(-1)).toMatchObject({ output: outcome });
  });

  it.each(["root", "finished", "active", "followed-up"] as const)(
    "projects a followed-up child into a fresh delegate (parent: %s)",
    async (parentState) => {
      const { fake, model } = setup();
      const nested = parentState !== "root";
      const outcome = { output: "verified", attachments: [], title: "Lookup" };
      const execute = vi.fn(async () => outcome);
      const requests = vi.fn(async () => ({
        answers: { mode: { answers: ["Fast"] } },
      }));
      let staleQuestionReply: Message | undefined;
      const tools = {
        lookup: {
          description: "Lookup",
          inputSchema: z.object({}),
          execute,
          toModelOutput: () => "verified",
        },
      };
      onTurn(fake, async (thread, turn) => {
        const root = { threadId: thread, turnId: turn };
        const parent = nested
          ? { threadId: "parent", turnId: "parent_turn" }
          : root;
        const child = { threadId: "child", turnId: "first_turn" };
        const resumed = { ...child, turnId: "second_turn" };
        const activity = (
          scope: typeof root,
          target: string,
          id: string,
          kind: string,
        ) =>
          fake.notify("item/completed", {
            ...scope,
            item: {
              type: "subAgentActivity",
              id,
              kind,
              agentThreadId: target,
              agentPath: `/root/${target}`,
            },
          });
        const start = (scope: typeof root) =>
          fake.notify("turn/started", {
            threadId: scope.threadId,
            turn: { id: scope.turnId, status: "inProgress" },
          });
        if (nested) {
          activity(root, parent.threadId, "spawn_parent", "started");
          start(parent);
        }
        activity(parent, child.threadId, "spawn_child", "started");
        start(child);
        fake.notify("item/completed", {
          ...child,
          item: agentMessage("first_answer", "first answer"),
        });
        fake.notify("turn/completed", completed(child.threadId, child.turnId));
        if (parentState === "finished" || parentState === "followed-up")
          fake.notify(
            "turn/completed",
            completed(parent.threadId, parent.turnId),
          );
        const currentParent =
          parentState === "followed-up"
            ? { ...parent, turnId: "parent_followup" }
            : parent;
        if (parentState === "followed-up") {
          activity(root, parent.threadId, "followup_parent", "interacted");
          start(currentParent);
        }
        // An interaction alone is not evidence that another child turn began.
        activity(
          parentState === "finished" ? root : currentParent,
          child.threadId,
          "message_only",
          "interacted",
        );
        fake.notify("item/completed", {
          ...root,
          item: agentMessage("after_message", "after message"),
        });
        start(resumed);
        start(resumed);
        // Old completion notifications must not seal the new invocation.
        fake.notify("turn/completed", completed(child.threadId, child.turnId));
        activity(root, child.threadId, "late_terminal", "completed");
        fake.notify("item/completed", {
          ...child,
          item: agentMessage("late_answer", "stale answer"),
        });
        expect(
          await fake.ask("item/tool/call", {
            ...child,
            callId: "stale_call",
            tool: "lookup",
            arguments: {},
          }),
        ).toMatchObject({ result: { success: false } });
        staleQuestionReply = await fake.ask("item/tool/requestUserInput", {
          ...child,
          itemId: "stale_question",
          isBlocking: false,
          questions: [{ id: "mode", header: "Mode", question: "Choose" }],
        });
        fake.notify("item/completed", {
          ...resumed,
          item: agentMessage("second_start", "second turn working"),
        });
        await fake.ask("item/tool/call", {
          ...resumed,
          callId: "lookup_call",
          tool: "lookup",
          arguments: {},
        });
        fake.notify("item/completed", {
          ...resumed,
          item: {
            type: "dynamicToolCall",
            id: "lookup_call",
            tool: "lookup",
            arguments: {},
            status: "completed",
            success: true,
          },
        });
        fake.notify("item/completed", {
          ...resumed,
          item: agentMessage("second_answer", "second answer"),
        });
        fake.notify(
          "turn/completed",
          completed(resumed.threadId, resumed.turnId),
        );
        if (parentState === "active" || parentState === "followed-up")
          fake.notify(
            "turn/completed",
            completed(currentParent.threadId, currentParent.turnId),
          );
        fake.notify("turn/completed", completed(thread, turn));
      });
      const events = await collect(
        conformProviderStream(
          streamText({
            model,
            messages: [{ role: "user", content: "follow up" }],
            providerOptions: {
              "codex-app-server": { tools, requests },
            } as never,
            maxRetries: 0,
          }).fullStream,
        ),
      );
      const delegates = events.filter(
        (event): event is Extract<ModelStreamEvent, { type: "tool-call" }> =>
          event.type === "tool-call" &&
          event.providerMetadata?.openchart?.openDelegate !== undefined,
      );
      expect(delegates).toHaveLength(
        parentState === "followed-up" ? 4 : nested ? 3 : 2,
      );
      const resumed = delegates.at(-1)!;
      expect(resumed.toolCallId).not.toBe("spawn_child");
      const expectedParent =
        parentState === "active"
          ? "spawn_parent"
          : parentState === "followed-up"
            ? delegates.at(-2)!.toolCallId
            : "root";
      expect(owner(resumed)).toBe(expectedParent);
      expect(events.indexOf(resumed)).toBeGreaterThan(
        events.findIndex(
          (event) =>
            event.type === "text-delta" && event.text === "after message",
        ),
      );
      expect(
        compact(events.filter((event) => owner(event) === resumed.toolCallId)),
      ).toEqual([
        `start-step:${resumed.toolCallId}`,
        `text-delta:${resumed.toolCallId}:second turn working`,
        `tool-call:${resumed.toolCallId}:lookup`,
        `tool-result:${resumed.toolCallId}:lookup`,
        `text-delta:${resumed.toolCallId}:second answer`,
        `finish-step:${resumed.toolCallId}`,
      ]);
      expect(execute).toHaveBeenCalledOnce();
      expect(staleQuestionReply).toMatchObject({ result: { answers: {} } });
      expect(requests).not.toHaveBeenCalled();
      expect(
        events.find(
          (event) =>
            event.type === "tool-result" && event.toolCallId === "lookup_call",
        ),
      ).toMatchObject({ output: outcome });
      const active = new Set<string>();
      for (const event of events) {
        if (event.type === "start" || event.type === "finish") continue;
        if (event.type === "start-step") {
          expect(active.has(owner(event))).toBe(false);
          active.add(owner(event));
        } else {
          expect(
            active.has(owner(event)),
            `${event.type} in ${owner(event)}`,
          ).toBe(true);
          if (event.type === "finish-step") active.delete(owner(event));
        }
      }
      expect(active.size).toBe(0);
    },
  );

  it("keeps nested activity identities and finishes descendants before their parents", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      const activity = (
        parentThreadId: string,
        childThreadId: string,
        id: string,
        kind: string,
      ) =>
        fake.notify("item/completed", {
          threadId: parentThreadId,
          turnId: turn,
          item: {
            type: "subAgentActivity",
            id,
            kind,
            agentThreadId: childThreadId,
            // Display names are not identity: these distinct threads share a label.
            agentPath: "reviewer",
          },
        });
      activity(thread, "child", "spawn_child", "started");
      activity("child", "grandchild", "spawn_grandchild", "started");
      activity("child", "grandchild", "message_grandchild", "interacted");
      activity(thread, "child", "done_child", "completed");
      fake.notify("item/completed", {
        threadId: "grandchild",
        turnId: turn,
        item: agentMessage("answer", "nested result"),
      });
      activity("child", "grandchild", "done_grandchild", "completed");
      activity(thread, "child", "done_child", "completed");
      fake.notify("turn/completed", completed(thread, turn));
    });
    const events = await collect(
      conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "delegate" }],
          maxRetries: 0,
        }).fullStream,
      ),
    );
    expect(compact(events)).toEqual([
      "start-step:root",
      "tool-call:root:spawn_agent",
      "start-step:spawn_child",
      "tool-call:spawn_child:spawn_agent",
      "start-step:spawn_grandchild",
      "tool-call:spawn_child:agent_interaction",
      "tool-result:spawn_child:agent_interaction",
      "text-delta:spawn_grandchild:nested result",
      "finish-step:spawn_grandchild",
      "tool-result:spawn_child:spawn_agent",
      "finish-step:spawn_child",
      "tool-result:root:spawn_agent",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "tool-call" && event.toolName === "spawn_agent",
      ),
    ).toMatchObject([
      {
        toolCallId: "spawn_child",
        providerMetadata: { openchart: { openDelegate: expect.any(Object) } },
      },
      {
        toolCallId: "spawn_grandchild",
        providerMetadata: {
          openchart: {
            delegateCallId: "spawn_child",
            openDelegate: expect.any(Object),
          },
        },
      },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "tool-result" && event.toolName === "spawn_agent",
      ),
    ).toMatchObject([
      { toolCallId: "spawn_grandchild" },
      { toolCallId: "spawn_child" },
    ]);
  });

  it.each(["/root", "/root/sibling"])(
    "keeps a child's interaction with %s in the sender's scope",
    async (target) => {
      const { fake, model } = setup();
      onTurn(fake, (thread, turn) => {
        const root = { threadId: thread, turnId: turn };
        const child = { threadId: "child", turnId: "child_turn" };
        const activity = {
          type: "subAgentActivity",
          id: "spawn",
          kind: "started",
          agentThreadId: child.threadId,
          agentPath: "/root/reviewer",
        };
        fake.notify("item/completed", { ...root, item: activity });
        const interaction = {
          ...activity,
          id: "message",
          kind: "interacted",
          agentThreadId: target === "/root" ? thread : "sibling",
          agentPath: target,
        };
        fake.notify("item/started", { ...child, item: interaction });
        fake.notify("item/completed", { ...child, item: interaction });
        fake.notify("item/completed", { ...child, item: interaction });
        // Neither a notification nor an orphan terminal event establishes ancestry.
        for (const kind of ["completed", "interrupted"]) {
          fake.notify("item/completed", {
            ...child,
            item: { ...interaction, id: kind, kind },
          });
        }
        fake.notify("item/completed", {
          ...child,
          item: agentMessage("answer", "child continues"),
        });
        fake.notify("turn/completed", completed(child.threadId, child.turnId));
        fake.notify("turn/completed", completed(thread, turn));
      });
      const events = await collect(
        conformProviderStream(
          streamText({
            model,
            messages: [{ role: "user", content: "delegate" }],
            maxRetries: 0,
          }).fullStream,
        ),
      );
      expect(compact(events)).toEqual([
        "start-step:root",
        "tool-call:root:spawn_agent",
        "start-step:spawn",
        "tool-call:spawn:agent_interaction",
        "tool-result:spawn:agent_interaction",
        "text-delta:spawn:child continues",
        "finish-step:spawn",
        "tool-result:root:spawn_agent",
        "finish-step:root",
        "finish:stop",
      ]);
      expect(
        events.find(
          (event) =>
            event.type === "tool-call" && event.toolCallId === "message",
        ),
      ).toMatchObject({
        toolName: "agent_interaction",
        input: { target },
        providerMetadata: {
          openchart: {
            delegateCallId: "spawn",
          },
        },
      });
    },
  );

  it("binds activity-announced subagents and seals children the root leaves open", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      const root = { threadId: thread, turnId: turn };
      const child = { threadId: "child_2", turnId: "child_turn" };
      fake.notify("item/started", {
        ...root,
        item: {
          type: "subAgentActivity",
          id: "act_1",
          kind: "started",
          agentThreadId: "child_2",
          agentPath: "reviewer",
        },
      });
      fake.notify("item/started", {
        ...child,
        item: {
          type: "commandExecution",
          id: "cc",
          command: "pytest",
          cwd: "/w",
          status: "inProgress",
        },
      });
      fake.notify("item/agentMessage/delta", {
        ...child,
        itemId: "cm",
        delta: "working",
      });
      // The root completes while the child's command and text are still open.
      fake.notify("turn/completed", completed(thread, turn));
    });
    const events = await collect(
      conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "delegate" }],
          maxRetries: 0,
        }).fullStream,
      ),
    );
    expect(compact(events)).toEqual([
      "start-step:root",
      "tool-call:root:spawn_agent",
      "start-step:act_1",
      "tool-call:act_1:exec",
      "text-delta:act_1:working",
      "tool-error:act_1:exec",
      "finish-step:act_1",
      "tool-result:root:spawn_agent",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      providerMetadata: {
        openchart: {
          openDelegate: { description: "reviewer" },
        },
      },
    });
  });

  it("reuses the thread for an appended user turn and injects history otherwise", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      fake.notify("item/completed", {
        threadId: thread,
        turnId: turn,
        item: agentMessage("m", "reply"),
      });
      fake.notify("turn/completed", completed(thread, turn));
    });
    const call = (prompt: LanguageModelV4Prompt) =>
      model
        .doStream({ prompt } as LanguageModelV4CallOptions)
        .then(({ stream }) => drain(stream));
    const system: LanguageModelV4Prompt[number] = {
      role: "system",
      content: "sys",
    };
    await call([system, user("one")]);
    await call([system, user("one"), assistant("reply"), user("two")]);
    expect(fake.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
      "turn/start",
    ]);
    expect(
      fake.calls("turn/start").map((request) => request.params.threadId),
    ).toEqual(["thread_1", "thread_1"]);
    expect(fake.calls("turn/start")[1]!.params.input).toEqual([
      { type: "text", text: "two", text_elements: [] },
    ]);

    // An edited past misses: fresh thread with the full history injected.
    await call([
      system,
      user("one edited"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "search",
            input: { q: 1 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "search",
            output: { type: "json", value: { hits: 2 } },
          },
        ],
      },
      assistant("reply"),
      user("three"),
    ]);
    expect(fake.requests.slice(4).map((request) => request.method)).toEqual([
      "thread/start",
      "thread/inject_items",
      "turn/start",
    ]);
    expect(fake.calls("thread/inject_items")[0]!.params).toEqual({
      threadId: "thread_2",
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "one edited" }],
        },
        {
          type: "function_call",
          call_id: "t1",
          name: "search",
          arguments: '{"q":1}',
        },
        { type: "function_call_output", call_id: "t1", output: '{"hits":2}' },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "reply" }],
        },
      ],
    });
    // Concurrent forks cannot share the remembered thread.
    const forkPrompt: LanguageModelV4Prompt = [
      system,
      user("one"),
      assistant("reply"),
      user("two"),
      assistant("reply"),
      user("fork"),
    ];
    await Promise.all([call(forkPrompt), call(forkPrompt)]);
    expect(fake.calls("thread/start")).toHaveLength(3);
  });

  it.each([false, true])(
    "injects completed host work after the user message (prior turn: %s)",
    async (priorTurn) => {
      const { fake, model } = setup();
      onTurn(fake, (thread, turn) => {
        fake.notify("turn/completed", completed(thread, turn));
      });
      const call = (prompt: LanguageModelV4Prompt) =>
        model
          .doStream({ prompt } as LanguageModelV4CallOptions)
          .then(({ stream }) => drain(stream));
      if (priorTurn) await call([user("earlier")]);
      const output = JSON.stringify({
        detail: "x".repeat(5000),
        summary: "COMPLETED_RESULT",
      });
      await call([
        ...(priorTurn ? [user("earlier"), assistant("reply")] : []),
        user("Run the requested workflow"),
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "host-call",
              toolName: "workflow",
              input: { topic: "tea", round: 2 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "host-call",
              toolName: "workflow",
              output: { type: "text", value: output },
            },
          ],
        },
      ]);
      expect(fake.calls("thread/start")).toHaveLength(priorTurn ? 2 : 1);
      const injected = fake.calls("thread/inject_items").at(-1)?.params
        .items as unknown[];
      expect(injected).toHaveLength(priorTurn ? 5 : 3);
      expect(injected.slice(-3)).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run the requested workflow" }],
        },
        {
          type: "function_call",
          call_id: "host-call",
          name: "workflow",
          arguments: '{"topic":"tea","round":2}',
        },
        { type: "function_call_output", call_id: "host-call", output },
      ]);
      expect(fake.calls("turn/start").at(-1)!.params.input).toEqual([
        {
          type: "text",
          text: "Continue from the conversation above.",
          text_elements: [],
        },
      ]);
    },
  );

  it("interrupts the native turn on abort and closes on its terminal notification", async () => {
    const { fake, model } = setup();
    const controller = new AbortController();
    onTurn(fake, (thread, turn) => {
      fake.notify("item/agentMessage/delta", {
        threadId: thread,
        turnId: turn,
        itemId: "m",
        delta: "partial",
      });
      setImmediate(() => controller.abort());
    });
    fake.respond("turn/interrupt", (params) => {
      setImmediate(() =>
        fake.notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: params.turnId, status: "interrupted" },
        }),
      );
      return {};
    });
    const { stream } = await model.doStream({
      prompt: [user("go")],
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    const parts = await drain(stream);
    expect(fake.calls("turn/interrupt")[0]!.params).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
    });
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "interrupted" },
    });
    expect(parts.filter((part) => part.type === "text-end")).toHaveLength(1);
  });

  it("reports turn failures as finish reasons and fatal errors as stream errors", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) =>
      fake.notify("turn/completed", {
        threadId: thread,
        turn: {
          id: turn,
          status: "failed",
          error: {
            message: "too long",
            codexErrorInfo: "contextWindowExceeded",
          },
        },
      }),
    );
    const first = await drain(
      (
        await model.doStream({
          prompt: [user("go")],
        } as LanguageModelV4CallOptions)
      ).stream,
    );
    expect(first.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "length" },
    });

    onTurn(fake, (thread, turn) =>
      fake.notify("error", {
        threadId: thread,
        turnId: turn,
        error: { message: "quota" },
        willRetry: false,
      }),
    );
    await expect(
      drain(
        (
          await model.doStream({
            prompt: [user("again")],
          } as LanguageModelV4CallOptions)
        ).stream,
      ),
    ).rejects.toThrow("quota");
  });

  it("emits only the final assistant message in structured output mode", async () => {
    const { fake, model } = setup();
    onTurn(fake, (thread, turn) => {
      const scope = { threadId: thread, turnId: turn };
      fake.notify("item/agentMessage/delta", {
        ...scope,
        itemId: "a",
        delta: "Let me think",
      });
      fake.notify("item/completed", {
        ...scope,
        item: agentMessage("a", "Let me think"),
      });
      fake.notify("item/completed", {
        ...scope,
        item: agentMessage("b", '{"answer":42}'),
      });
      fake.notify("turn/completed", completed(thread, turn));
    });
    const schema = {
      type: "object",
      properties: { answer: { type: "number" } },
    };
    const parts = await drain(
      (
        await model.doStream({
          prompt: [user("go")],
          responseFormat: { type: "json", schema },
        } as LanguageModelV4CallOptions)
      ).stream,
    );
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta),
    ).toEqual(['{"answer":42}']);
    expect(fake.calls("turn/start")[0]!.params.outputSchema).toEqual(schema);
  });

  it("routes approvals to the owning request and declines unknown threads", async () => {
    const { fake, model } = setup();
    const requests = vi.fn(async (request: { method: string }) =>
      request.method === "item/commandExecution/requestApproval"
        ? { decision: "accept" }
        : undefined,
    );
    onTurn(fake, async (thread, turn) => {
      const scope = { threadId: thread, turnId: turn, itemId: "c1" };
      const own = await fake.ask("item/commandExecution/requestApproval", {
        ...scope,
        command: "ls",
      });
      expect(own.result).toEqual({ decision: "accept" });
      const input = await fake.ask("item/tool/requestUserInput", {
        ...scope,
        isBlocking: false,
        questions: [{ id: "mode", header: "Mode", question: "Choose" }],
      });
      expect(input.result).toEqual({ answers: {} });
      const foreign = await fake.ask("item/commandExecution/requestApproval", {
        ...scope,
        threadId: "someone_else",
        command: "rm",
      });
      expect(foreign.result).toEqual({ decision: "decline" });
      const permissions = await fake.ask("item/permissions/requestApproval", {
        ...scope,
        threadId: "someone_else",
        cwd: "/outside",
        permissions: { network: { enabled: true } },
      });
      expect(permissions.result).toEqual({ permissions: {}, scope: "turn" });
      const unknown = await fake.ask("account/chatgptAuthTokens/refresh", {});
      expect(unknown.error).toMatchObject({ code: -32601 });
      fake.notify("turn/completed", completed(thread, turn));
    });
    await drain(
      (
        await model.doStream({
          prompt: [user("go")],
          providerOptions: { "codex-app-server": { requests } },
        } as unknown as LanguageModelV4CallOptions)
      ).stream,
    );
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it("fails active turns when the process exits and respawns on the next request", async () => {
    const { fake, model } = setup();
    onTurn(fake, () => {
      setImmediate(() => fake.crash());
    });
    await expect(
      drain(
        (
          await model.doStream({
            prompt: [user("go")],
          } as LanguageModelV4CallOptions)
        ).stream,
      ),
    ).rejects.toThrow("exited");
    onTurn(fake, (thread, turn) =>
      fake.notify("turn/completed", completed(thread, turn)),
    );
    await drain(
      (
        await model.doStream({
          prompt: [user("go")],
        } as LanguageModelV4CallOptions)
      ).stream,
    );
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(fake.calls("initialize")).toHaveLength(2);
  });

  it("reads account state and pages models for discovery", async () => {
    const { fake, provider } = setup();
    fake.respond("model/list", (params) =>
      params.cursor
        ? { data: [{ model: "b", displayName: "B" }], nextCursor: null }
        : {
            data: [
              {
                model: "a",
                displayName: "A",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
            nextCursor: "next",
          },
    );
    await expect(provider.readAccount()).resolves.toMatchObject({
      requiresOpenaiAuth: true,
    });
    const first = await provider.listModels({ includeHidden: true });
    const second = await provider.listModels({
      includeHidden: true,
      cursor: first.nextCursor!,
    });
    expect(
      [...first.models, ...second.models].map((model) => model.model),
    ).toEqual(["a", "b"]);
    expect(fake.calls("initialize")[0]!.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
  });

  it("reads plan rate limits without reset-credit details", async () => {
    const { fake, provider } = setup();
    fake.respond("account/rateLimits/read", () => ({
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1 },
      },
    }));
    await expect(provider.readRateLimits()).resolves.toMatchObject({
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 99, windowDurationMins: 10080 } },
    });
    expect(fake.calls("account/rateLimits/read")[0]!.params).toEqual({
      excludeResetCreditDetails: true,
    });
  });
});

describe("history", () => {
  it.each(["assistant", "tool"] as const)(
    "bounds replay IDs and preserves call/result pairs with %s results",
    (resultRole) => {
      const asyncId =
        "async-question:01a0d726-90ed-7e53-ae25-6ffee1e19a4c:call_F7BAq6v8I6lEpMJDdhuTus8s";
      const ids = [
        "call_short",
        "a".repeat(64),
        "a".repeat(65),
        asyncId,
        `${asyncId.slice(0, -1)}t`,
      ];
      const prompt: LanguageModelV4Prompt = [
        user("first"),
        ...ids.flatMap((toolCallId): LanguageModelV4Prompt => [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId,
                toolName: "request_user_input_async",
                input: { questions: [] },
              },
            ],
          },
          {
            role: resultRole,
            content: [
              {
                type: "tool-result",
                toolCallId,
                toolName: "request_user_input_async",
                output: { type: "json", value: { answers: {} } },
              },
            ],
          },
        ]),
        user("second"),
      ];
      const original = structuredClone(prompt);
      const converted = convertPrompt(prompt);
      const replayIds = ids.map((id, index) => {
        const call = converted.history[index * 2 + 1] as { call_id: string };
        expect(call.call_id.length).toBeLessThanOrEqual(64);
        if (id.length <= 64) expect(call.call_id).toBe(id);
        expect(converted.history.slice(index * 2 + 1, index * 2 + 3)).toEqual([
          {
            type: "function_call",
            call_id: call.call_id,
            name: "request_user_input_async",
            arguments: '{"questions":[]}',
          },
          {
            type: "function_call_output",
            call_id: call.call_id,
            output: '{"answers":{}}',
          },
        ]);
        return call.call_id;
      });
      expect(new Set(replayIds).size).toBe(ids.length);
      expect(convertPrompt(prompt)).toEqual(converted);
      expect(prompt).toEqual(original);
    },
  );

  it("splits system, injected history, and final input, carrying images as data URLs", () => {
    const converted = convertPrompt([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      user("first"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "ok" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: new Uint8Array([1, 2, 3]) },
          },
        ],
      },
    ]);
    expect(converted.developerInstructions).toBe("a\n\nb");
    expect(converted.history).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ]);
    expect(converted.input).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "data:image/png;base64,AQID" },
    ]);
    expect(() => convertPrompt([{ role: "system", content: "only" }])).toThrow(
      "final user message",
    );
  });
});

describe("continuation", () => {
  it("rejects unseen host work and never reuses a stale hint after consuming it", () => {
    const continuation = createContinuation();
    const base: LanguageModelV4Prompt = [user("one")];
    const next = [...base, assistant("reply"), user("two")];
    continuation.keep(base, "tools", "old-native-thread");
    expect(
      continuation.take([...next, assistant("host work")], "tools"),
    ).toBeUndefined();
    // External work can also arrive after a previously completed user turn.
    continuation.keep(
      [...base, assistant("host work")],
      "tools",
      "replayed-thread",
    );
    expect(continuation.take(next, "tools")).toBeUndefined();
    continuation.keep(next, "tools", "normal-thread");
    expect(
      continuation.take([...next, assistant("reply"), user("three")], "tools"),
    ).toBe("normal-thread");
  });

  it("hits only for append-only prompts with matching configuration", () => {
    const continuation = createContinuation();
    const base: LanguageModelV4Prompt = [user("one")];
    continuation.keep(base, "tools", "thread_a");
    expect(
      continuation.take([...base, assistant("r"), user("two")], "other"),
    ).toBeUndefined();
    expect(
      continuation.take([...base, user("extra"), user("two")], "tools"),
    ).toBeUndefined();
    expect(
      continuation.take([...base, assistant("r"), user("two")], "tools"),
    ).toBe("thread_a");
    // Consumed exclusively.
    expect(
      continuation.take([...base, assistant("r"), user("two")], "tools"),
    ).toBeUndefined();
  });
});

it("records native question answers in the stream and passes cancellation to the host", async () => {
  const { fake, model } = setup();
  const answers = { mode: ["Fast"] };
  const askQuestion = vi.fn(async () => ({
    type: "answered" as const,
    answers,
  }));
  onTurn(fake, async (thread, turn) => {
    const result = await fake.ask("item/tool/requestUserInput", {
      threadId: thread,
      turnId: turn,
      itemId: "question",
      isBlocking: false,
      questions: [
        {
          id: "mode",
          header: "Mode",
          question: "Choose",
          options: [{ label: "Fast", description: "Quick result" }],
        },
      ],
    });
    expect(result.result).toEqual({ answers: { mode: { answers: ["Fast"] } } });
    fake.notify("turn/completed", completed(thread, turn));
  });
  const parts = await drain(
    (
      await model.doStream({
        prompt: [user("go")],
        providerOptions: {
          "codex-app-server": codex.requestOptions({
            cwd: "/workspace",
            tools: {},
            permissionMode: "full-access",
            askPermission: vi.fn(),
            askQuestion,
          }),
        },
      } as unknown as LanguageModelV4CallOptions)
    ).stream,
  );
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "tool-call",
      toolCallId: "question",
      toolName: "request_user_input",
    }),
  );
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "tool-result",
      toolCallId: "question",
      result: { answers: { mode: { answers: ["Fast"] } } },
    }),
  );
  expect(askQuestion).toHaveBeenCalledOnce();
});

it.each(["resolved", "completed", "crashed"] as const)(
  "cancels a pending question when the native request is %s",
  async (ending) => {
    const { fake, model } = setup();
    let nativeSignal: AbortSignal | undefined;
    const askQuestion = vi.fn(
      (_request, { signal }: { signal: AbortSignal }) => {
        nativeSignal = signal;
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    );
    onTurn(fake, (thread, turn) => {
      void fake.ask("item/tool/requestUserInput", {
        threadId: thread,
        turnId: turn,
        itemId: "question",
        isBlocking: false,
        questions: [{ id: "mode", header: "Mode", question: "Choose" }],
      });
      void vi
        .waitFor(() => expect(nativeSignal).toBeDefined())
        .then(() => {
          if (ending === "resolved")
            fake.notify("serverRequest/resolved", {
              threadId: thread,
              requestId: 1000,
            });
          if (ending === "crashed") fake.crash();
          else fake.notify("turn/completed", completed(thread, turn));
        });
    });
    const output = drain(
      (
        await model.doStream({
          prompt: [user("go")],
          providerOptions: {
            "codex-app-server": codex.requestOptions({
              cwd: "/workspace",
              tools: {},
              permissionMode: "ask",
              askPermission: vi.fn(),
              askQuestion,
            }),
          },
        } as unknown as LanguageModelV4CallOptions)
      ).stream,
    );
    if (ending === "crashed") await expect(output).rejects.toThrow("exited");
    else await output;
    expect(nativeSignal?.aborted).toBe(true);
  },
);

describe("async questions", () => {
  const question = {
    ...agentMessage("question", ""),
    questions: [
      { title: "Choose a mode", options: ["Fast", "Thorough"] },
      { title: "Any constraints?", options: null },
    ],
  };
  const providerOptions = (askQuestion: ProviderQuestionAsk) => ({
    "codex-app-server": codex.requestOptions({
      cwd: "/workspace",
      tools: {},
      permissionMode: "full-access",
      askPermission: vi.fn(),
      askQuestion,
    }),
  });

  it("surfaces once through the existing callback, streams while waiting, and steers the original turn", async () => {
    const { fake, model } = setup();
    let answer!: (reply: ProviderQuestionReply) => void;
    const reply = new Promise<ProviderQuestionReply>((resolve) => {
      answer = resolve;
    });
    const askQuestion = vi.fn<ProviderQuestionAsk>(() => reply);
    onTurn(fake, (threadId, turnId) => {
      for (let index = 0; index < 2; index++)
        fake.notify("item/completed", { threadId, turnId, item: question });
      fake.notify("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: "progress",
        delta: "Continuing work",
      });
    });
    const events: ModelStreamEvent[] = [];
    const output = (async () => {
      for await (const event of conformProviderStream(
        streamText({
          model,
          messages: [{ role: "user", content: "go" }],
          providerOptions: providerOptions(askQuestion) as never,
          maxRetries: 0,
        }).fullStream,
      ))
        events.push(event);
    })();
    await vi.waitFor(() =>
      expect(compact(events)).toContain("text-delta:root:Continuing work"),
    );
    expect(askQuestion).toHaveBeenCalledOnce();
    expect(askQuestion.mock.calls[0]![0]).toEqual({
      questions: [
        {
          id: "0",
          header: "Choose a mode",
          question: "Choose a mode",
          options: [
            { label: "Fast", description: "" },
            { label: "Thorough", description: "" },
          ],
          multiple: false,
          allowFreeform: true,
          secret: false,
        },
        {
          id: "1",
          header: "Any constraints?",
          question: "Any constraints?",
          options: [],
          multiple: false,
          allowFreeform: true,
          secret: false,
        },
      ],
    });
    answer({
      type: "answered",
      answers: { "0": ["Fast"], "1": ["Keep it small"] },
    });
    await vi.waitFor(() =>
      expect(compact(events)).toContain(
        "tool-result:root:request_user_input_async",
      ),
    );
    const threadId = fake.calls("turn/start")[0]!.params.threadId as string;
    expect(fake.calls("turn/steer")).toHaveLength(1);
    expect(fake.calls("turn/steer")[0]!.params).toMatchObject({
      threadId,
      expectedTurnId: "turn_1",
      input: [{ type: "text", text: expect.stringContaining("Keep it small") }],
    });
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(
      1,
    );
    fake.notify("turn/completed", completed(threadId, "turn_1"));
    await output;
    expect(askQuestion.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(fake.calls("turn/start")).toHaveLength(1);
  });

  it.each(["completed", "aborted", "crashed", "expired"] as const)(
    "discards a late answer when the question is %s",
    async (ending) => {
      const { fake, model } = setup();
      let answer!: (reply: ProviderQuestionReply) => void;
      const reply = new Promise<ProviderQuestionReply>((resolve) => {
        answer = resolve;
      });
      const askQuestion = vi.fn<ProviderQuestionAsk>(() => reply);
      const abort = new AbortController();
      const timeout = new AbortController();
      const timeoutSpy =
        ending === "expired"
          ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
          : undefined;
      try {
        onTurn(fake, (threadId, turnId) =>
          fake.notify("item/completed", { threadId, turnId, item: question }),
        );
        const { stream } = await model.doStream({
          prompt: [user("go")],
          abortSignal: abort.signal,
          providerOptions: providerOptions(askQuestion),
        } as unknown as LanguageModelV4CallOptions);
        const output = drain(stream);
        // Attach rejection handling before simulating a process crash.
        const finished =
          ending === "crashed"
            ? expect(output).rejects.toThrow("exited")
            : output;
        await vi.waitFor(() => expect(askQuestion).toHaveBeenCalledOnce());
        const threadId = fake.calls("turn/start")[0]!.params.threadId as string;
        if (ending === "aborted") abort.abort();
        else if (ending === "crashed") fake.crash();
        else if (ending === "expired") {
          expect(timeoutSpy).toHaveBeenCalledWith(60_000);
          timeout.abort();
        } else fake.notify("turn/completed", completed(threadId, "turn_1"));
        await vi.waitFor(() =>
          expect(askQuestion.mock.calls[0]![1].signal.aborted).toBe(true),
        );
        answer({ type: "answered", answers: { "0": ["Too late"] } });
        if (ending === "aborted" || ending === "expired")
          fake.notify("turn/completed", completed(threadId, "turn_1"));
        await finished;
        expect(fake.calls("turn/steer")).toHaveLength(0);
        expect(fake.calls("turn/start")).toHaveLength(1);
      } finally {
        timeoutSpy?.mockRestore();
      }
    },
  );

  it.each(["skipped", "delivery-failed"] as const)(
    "continues after %s without retrying",
    async (outcome) => {
      const { fake, model } = setup();
      const askQuestion = vi.fn<ProviderQuestionAsk>(async () =>
        outcome === "skipped"
          ? { type: "skipped" }
          : { type: "answered", answers: { "0": ["Fast"] } },
      );
      fake.respond("turn/steer", () =>
        Promise.reject(new Error("Turn no longer active")),
      );
      onTurn(fake, (threadId, turnId) =>
        fake.notify("item/completed", { threadId, turnId, item: question }),
      );
      const { stream } = await model.doStream({
        prompt: [user("go")],
        providerOptions: providerOptions(askQuestion),
      } as unknown as LanguageModelV4CallOptions);
      const reader = stream.getReader();
      let result: LanguageModelV4StreamPart | undefined;
      while (result?.type !== "tool-result")
        result = (await reader.read()).value;
      expect(result).toMatchObject(
        outcome === "skipped"
          ? { result: { answers: {} } }
          : {
              isError: true,
              result: expect.stringContaining("Turn no longer active"),
            },
      );
      const threadId = fake.calls("turn/start")[0]!.params.threadId as string;
      fake.notify("turn/completed", completed(threadId, "turn_1"));
      while (!(await reader.read()).done) {
        /* consume the normal finish */
      }
      expect(fake.calls("turn/steer")).toHaveLength(
        outcome === "skipped" ? 0 : 1,
      );
      expect(fake.calls("turn/start")).toHaveLength(1);
    },
  );

  it.each(["turn", "activity"] as const)(
    "expires a child's question on %s completion in its own scope, leaving the parent's live",
    async (ending) => {
      const { fake, model } = setup();
      const askQuestion = vi.fn<ProviderQuestionAsk>(
        (_request, { signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      );
      onTurn(fake, (threadId, turnId) => {
        fake.notify("thread/started", {
          thread: { id: "child", parentThreadId: threadId },
        });
        fake.notify("item/completed", {
          threadId: "child",
          turnId: "child_turn",
          item: question,
        });
        fake.notify("item/completed", {
          threadId,
          turnId,
          item: {
            type: "collabAgentToolCall",
            id: "spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: threadId,
            receiverThreadIds: ["child"],
            prompt: "review",
            model: "gpt-test",
            agentsStates: { child: { status: "running" } },
          },
        });
        fake.notify("item/completed", { threadId, turnId, item: question });
      });
      const events: ModelStreamEvent[] = [];
      const output = (async () => {
        for await (const event of conformProviderStream(
          streamText({
            model,
            messages: [{ role: "user", content: "go" }],
            providerOptions: providerOptions(askQuestion) as never,
            maxRetries: 0,
          }).fullStream,
        ))
          events.push(event);
      })();
      await vi.waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(2));
      expect(compact(events)).toContain(
        "tool-call:spawn:request_user_input_async",
      );
      const threadId = fake.calls("turn/start")[0]!.params.threadId as string;
      if (ending === "turn")
        fake.notify("turn/completed", completed("child", "child_turn"));
      else
        fake.notify("item/completed", {
          threadId,
          turnId: "turn_1",
          item: {
            type: "subAgentActivity",
            id: "child_finished",
            kind: "completed",
            agentThreadId: "child",
            agentPath: "/root/reviewer",
          },
        });
      await vi.waitFor(() =>
        expect(askQuestion.mock.calls[0]![1].signal.aborted).toBe(true),
      );
      expect(askQuestion.mock.calls[1]![1].signal.aborted).toBe(false);
      fake.notify("turn/completed", completed(threadId, "turn_1"));
      await output;
      const trace = compact(events);
      expect(trace).toContain("tool-error:spawn:request_user_input_async");
      expect(trace).toContain("finish-step:spawn");
      expect(
        trace.indexOf("tool-error:spawn:request_user_input_async"),
      ).toBeLessThan(trace.indexOf("finish-step:spawn"));
      expect(askQuestion.mock.calls[1]![1].signal.aborted).toBe(true);
      expect(fake.calls("turn/steer")).toHaveLength(0);
    },
  );
});
