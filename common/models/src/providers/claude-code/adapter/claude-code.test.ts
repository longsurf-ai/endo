// Purpose: Drives the Claude adapter against a scripted Agent SDK through the real AI SDK stream and conformer.
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { streamText, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { claudeCode } from "@openchart/models/providers/claude-code/binding";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";

type Part = Record<string, unknown>;
type Scenario = (received: {
  content: unknown;
  options: Options;
  interrupted: Promise<void>;
}) => AsyncGenerator<Part>;

/** Each query takes the next scripted scenario; the fake records what the adapter sent. */
const script = vi.hoisted(() => ({
  scenarios: [] as Scenario[],
  queries: [] as Array<{
    options: Options;
    content: unknown;
    interrupt: ReturnType<typeof vi.fn>;
  }>,
  sessions: new Set<string>(["known-session"]),
  auth: { code: 0, stdout: JSON.stringify({ loggedIn: true }) },
  models: [{ value: "sonnet", displayName: "Sonnet", description: "" }],
  usage: { subscription_type: "max", rate_limits_available: false },
  usageReads: [] as unknown[],
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (
      error: unknown,
      result?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    if (script.auth.code === 0)
      callback(null, { stdout: script.auth.stdout, stderr: "" });
    else
      callback(
        Object.assign(new Error("exit"), {
          code: script.auth.code,
          stdout: script.auth.stdout,
        }),
      );
  },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionInfo: async (sessionId: string) =>
    script.sessions.has(sessionId) ? { sessionId } : undefined,
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({
    type: "sdk",
    name: options.name,
    instance: {},
    tools: options.tools,
  }),
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: unknown,
  ) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
  query(input: {
    prompt: AsyncIterable<SDKUserMessage> | string;
    options: Options;
  }) {
    // Discovery never iterates its query, so only streamed turns are scripted.
    const scenario: Scenario =
      script.scenarios.shift() ?? async function* () {};
    let resolveInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
    const record = {
      options: input.options,
      content: undefined as unknown,
      interrupt: vi.fn(async () => resolveInterrupt()),
    };
    script.queries.push(record);
    async function* messages() {
      const first =
        typeof input.prompt === "string"
          ? { value: input.prompt }
          : await input.prompt[Symbol.asyncIterator]().next();
      record.content =
        (first.value as SDKUserMessage | undefined)?.message?.content ??
        first.value;
      yield* scenario({
        content: record.content,
        options: input.options,
        interrupted,
      });
    }
    return {
      [Symbol.asyncIterator]: messages,
      interrupt: record.interrupt,
      close: vi.fn(),
      supportedModels: async () => script.models,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (
        options: unknown,
      ) => {
        script.usageReads.push(options);
        return script.usage;
      },
    };
  },
}));

const { createClaudeCodeProvider } = await import("./provider");

// Native message builders

let sequence = 0;
const uuid = () => `m${++sequence}`;
const init = (session = "session-1"): Part => ({
  type: "system",
  subtype: "init",
  session_id: session,
  model: "sonnet",
  tools: [],
  mcp_servers: [],
  uuid: uuid(),
});
const assistant = (content: Part[], parent: string | null = null): Part => ({
  type: "assistant",
  message: { role: "assistant", content },
  parent_tool_use_id: parent,
  uuid: uuid(),
  session_id: "session-1",
});
const user = (content: Part[], parent: string | null = null): Part => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: parent,
  uuid: uuid(),
  session_id: "session-1",
});
const event = (data: Part, parent: string | null = null): Part => ({
  type: "stream_event",
  event: data,
  parent_tool_use_id: parent,
  uuid: uuid(),
  session_id: "session-1",
});
function* streamed(
  index: number,
  kind: "text" | "thinking",
  value: string,
): Generator<Part> {
  yield event({
    type: "content_block_start",
    index,
    content_block: { type: kind, [kind]: "" },
  });
  yield event({
    type: "content_block_delta",
    index,
    delta: { type: `${kind}_delta`, [kind]: value },
  });
  yield assistant([{ type: kind, [kind]: value }]);
  yield event({ type: "content_block_stop", index });
}
const toolUse = (
  id: string,
  name: string,
  input: Part,
  parent: string | null = null,
) => assistant([{ type: "tool_use", id, name, input }], parent);
const toolResult = (
  id: string,
  content: unknown,
  parent: string | null = null,
  isError = false,
) =>
  user(
    [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    parent,
  );
const result = (extra: Part = {}): Part => ({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 6,
    output_tokens: 5,
    output_tokens_details: { thinking_tokens: 2 },
  },
  permission_denials: [],
  uuid: uuid(),
  session_id: "session-1",
  ...extra,
});

// Stream helpers

function owner(part: {
  providerMetadata?: { openchart?: { delegateCallId?: string } };
}): string {
  return part.providerMetadata?.openchart?.delegateCallId ?? "root";
}

function compact(events: ModelStreamEvent[]): string[] {
  return events.flatMap((part) => {
    switch (part.type) {
      case "text-delta":
        return [`text-delta:${owner(part)}:${part.text}`];
      case "reasoning-delta":
        return [`reasoning-delta:${owner(part)}:${part.text}`];
      case "tool-call":
        return [`tool-call:${owner(part)}:${part.toolName}`];
      case "tool-result":
        return [`tool-result:${owner(part)}:${part.toolName}`];
      case "tool-error":
        return [`tool-error:${owner(part)}:${part.toolName}`];
      case "start-step":
      case "finish-step":
        return [`${part.type}:${owner(part)}`];
      case "finish":
        return [`finish:${part.finishReason}`];
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

const userMessage = (text: string): LanguageModelV4Prompt[number] => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistantMessage = (text: string): LanguageModelV4Prompt[number] => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const providers: Array<ReturnType<typeof createClaudeCodeProvider>> = [];
afterEach(async () => {
  script.scenarios.length = 0;
  script.queries.length = 0;
  script.auth = { code: 0, stdout: JSON.stringify({ loggedIn: true }) };
  script.usageReads.length = 0;
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
});

function setup() {
  const provider = createClaudeCodeProvider({
    executable: "/fake/claude",
    env: { DISABLE_AUTOUPDATER: "1" },
  });
  providers.push(provider);
  return { provider, model: provider.languageModel("sonnet") };
}

function run(
  model: ReturnType<typeof setup>["model"],
  input: ModelMessage[],
  extra: { system?: string; providerOptions?: unknown } = {},
) {
  return streamText({
    model,
    messages: input,
    maxRetries: 0,
    system: extra.system,
    providerOptions: extra.providerOptions as never,
  });
}

describe("Claude adapter", () => {
  it("applies binding permissions on every query and never resumes across a mode change", async () => {
    const { model } = setup();
    const prompt: LanguageModelV4Prompt = [userMessage("first")];
    for (const permissionMode of [
      "full-access",
      "full-access",
      "ask",
      "auto",
    ] as const) {
      script.scenarios.push(async function* () {
        yield init("known-session");
        yield result();
      });
      const options = claudeCode.requestOptions({
        cwd: "/workspace",
        tools: {},
        permissionMode,
        askPermission: vi.fn(async () => {}),
      });
      await drain(
        (
          await model.doStream({
            prompt: [...prompt],
            providerOptions: { "claude-code": options },
          } as unknown as LanguageModelV4CallOptions)
        ).stream,
      );
      expect(script.queries.at(-1)!.options).toMatchObject({
        permissionMode:
          permissionMode === "full-access"
            ? "bypassPermissions"
            : permissionMode === "auto"
              ? "auto"
              : "default",
        allowDangerouslySkipPermissions: permissionMode === "full-access",
        sandbox: { enabled: permissionMode !== "full-access" },
      });
      prompt.push(
        assistantMessage("done"),
        userMessage(`next ${prompt.length}`),
      );
    }
    expect(script.queries.map(({ options }) => options.resume)).toEqual([
      undefined,
      "known-session",
      undefined,
      undefined,
    ]);
  });

  it("streams root thinking and text and finishes with native usage", async () => {
    const { model } = setup();
    script.scenarios.push(async function* () {
      yield init();
      yield* streamed(0, "thinking", "hmm");
      yield* streamed(1, "text", "Hello");
      yield result();
    });
    const stream = run(model, [{ role: "user", content: "hi" }], {
      system: "Be brief.",
      providerOptions: { "claude-code": { cwd: "/workspace", effort: "low" } },
    });
    const events = await collect(conformProviderStream(stream.fullStream));
    expect(compact(events)).toEqual([
      "start-step:root",
      "reasoning-delta:root:hmm",
      "text-delta:root:Hello",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(events.find((part) => part.type === "finish-step")).toMatchObject({
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        inputTokenDetails: { cacheReadTokens: 6 },
      },
    });
    const [query] = script.queries;
    expect(query!.options).toMatchObject({
      model: "sonnet",
      cwd: "/workspace",
      effort: "low",
      strictMcpConfig: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      pathToClaudeCodeExecutable: "/fake/claude",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Be brief.",
      },
      env: expect.objectContaining({
        DISABLE_AUTOUPDATER: "1",
        MCP_TOOL_TIMEOUT: String(2 * 60 * 60 * 1000),
      }),
    });
    expect(query!.options.resume).toBeUndefined();
    expect(query!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("maps native tools, lifting image results into the media envelope", async () => {
    const { model } = setup();
    script.scenarios.push(async function* () {
      yield init();
      yield toolUse("bash_1", "Bash", { command: "ls" });
      yield toolResult("bash_1", "a.txt");
      yield toolUse("read_1", "Read", { file_path: "/shot.png" });
      yield toolResult("read_1", [
        { type: "text", text: "screenshot" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAA" },
        },
      ]);
      yield toolUse("bad_1", "Bash", { command: "false" });
      yield toolResult("bad_1", "exit 1", null, true);
      yield result();
    });
    const events = await collect(
      conformProviderStream(
        run(model, [{ role: "user", content: "go" }]).fullStream,
      ),
    );
    expect(compact(events)).toEqual([
      "start-step:root",
      "tool-call:root:Bash",
      "tool-result:root:Bash",
      "tool-call:root:Read",
      "tool-result:root:Read",
      "tool-call:root:Bash",
      "tool-error:root:Bash",
      "finish-step:root",
      "finish:stop",
    ]);
    const results = events.filter((part) => part.type === "tool-result");
    expect(results.map((part) => part.output)).toEqual([
      { output: "a.txt", attachments: [] },
      {
        output: "screenshot",
        attachments: [{ mime: "image/png", url: "data:image/png;base64,AAA" }],
      },
    ]);
    expect(events.find((part) => part.type === "tool-call")).toMatchObject({
      input: { command: "ls" },
      providerExecuted: true,
    });
  });

  it("runs OpenChart tools in-process and emits the exact outcome keyed by the SDK's tool use ID", async () => {
    const { model } = setup();
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
    script.scenarios.push(async function* ({ options }) {
      yield init();
      const server = options.mcpServers!["openchart"] as unknown as {
        tools: Array<{
          name: string;
          handler: (args: unknown, extra: unknown) => Promise<unknown>;
        }>;
      };
      const call = (name: string, args: unknown, id: string) =>
        server.tools
          .find((entry) => entry.name === name)!
          .handler(args, { _meta: { "claudecode/toolUseId": id } });
      yield toolUse("use_1", "mcp__openchart__search", { q: "AAPL" });
      const answer = await call("search", { q: "AAPL" }, "use_1");
      expect(answer).toEqual({
        content: [{ type: "text", text: '{"q":"AAPL"}' }],
      });
      yield toolResult("use_1", '{"q":"AAPL"}');
      yield toolUse("use_2", "mcp__openchart__failing", {});
      const failed = await call("failing", {}, "use_2");
      expect(failed).toEqual({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      });
      yield toolResult("use_2", "boom", null, true);
      yield* streamed(0, "text", "done");
      yield result();
    });
    const events = await collect(
      conformProviderStream(
        run(model, [{ role: "user", content: "search" }], {
          providerOptions: { "claude-code": { tools } } as never,
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
      expect.objectContaining({ toolCallId: "use_1" }),
    );
    expect(events.find((part) => part.type === "tool-result")).toMatchObject({
      providerExecuted: true,
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
      output: { full: true, input: { q: "AAPL" }, toolCallId: "use_1" },
    });
    expect(events.find((part) => part.type === "tool-error")).toMatchObject({
      error: "boom",
    });
    expect(script.queries[0]!.options.allowedTools).toEqual([
      "mcp__openchart__search",
      "mcp__openchart__failing",
    ]);
  });

  it("nests subagents from parent_tool_use_id and seals the child at its Task result", async () => {
    const { model } = setup();
    script.scenarios.push(async function* () {
      yield init();
      yield toolUse("task_1", "Task", {
        description: "review",
        prompt: "check",
        subagent_type: "general-purpose",
      });
      yield user([{ type: "text", text: "check" }], "task_1");
      yield assistant(
        [{ type: "thinking", thinking: "child thinks" }],
        "task_1",
      );
      yield toolUse("bash_c", "Bash", { command: "pytest" }, "task_1");
      yield toolResult("bash_c", "ok", "task_1");
      yield assistant([{ type: "text", text: "child says" }], "task_1");
      yield toolResult("task_1", "child says");
      yield* streamed(0, "text", "parent done");
      yield result();
    });
    const events = await collect(
      conformProviderStream(
        run(model, [{ role: "user", content: "delegate" }]).fullStream,
      ),
    );
    expect(compact(events)).toEqual([
      "start-step:root",
      "tool-call:root:Task",
      "start-step:task_1",
      "reasoning-delta:task_1:child thinks",
      "tool-call:task_1:Bash",
      "tool-result:task_1:Bash",
      "text-delta:task_1:child says",
      "finish-step:task_1",
      "tool-result:root:Task",
      "text-delta:root:parent done",
      "finish-step:root",
      "finish:stop",
    ]);
    expect(
      events.find((part) => part.type === "tool-call")?.providerMetadata
        ?.openchart,
    ).toEqual({
      openDelegate: {
        description: "review",
        prompt: "check",
        agent: "general-purpose",
      },
    });
  });

  it("resumes the remembered session for an appended turn and replays edited history otherwise", async () => {
    const { model } = setup();
    const turn: Scenario = async function* () {
      yield init("session-1");
      yield* streamed(0, "text", "reply");
      yield result();
    };
    script.scenarios.push(turn, turn, turn);
    script.sessions.add("session-1");
    const call = (prompt: LanguageModelV4Prompt) =>
      model
        .doStream({ prompt } as LanguageModelV4CallOptions)
        .then(({ stream }) => drain(stream));
    const system: LanguageModelV4Prompt[number] = {
      role: "system",
      content: "sys",
    };
    await call([system, userMessage("one")]);
    await call([
      system,
      userMessage("one"),
      assistantMessage("reply"),
      userMessage("two"),
    ]);
    await call([
      system,
      userMessage("edited"),
      assistantMessage("reply"),
      userMessage("three"),
    ]);
    const [first, second, third] = script.queries;
    expect(first!.options.resume).toBeUndefined();
    expect(second!.options.resume).toBe("session-1");
    expect(second!.content).toEqual([{ type: "text", text: "two" }]);
    expect(third!.options.resume).toBeUndefined();
    expect(third!.content).toEqual([
      {
        type: "text",
        text: "Conversation so far:\n\nHuman: edited\n\nAssistant: reply\n\nHuman:",
      },
      { type: "text", text: "three" },
    ]);
  });

  it.each([false, true])(
    "replays completed host work after the user message without truncation (prior turn: %s)",
    async (priorTurn) => {
      const { model } = setup();
      const turn: Scenario = async function* () {
        yield init("session-1");
        yield result();
      };
      script.scenarios.push(turn, turn);
      script.sessions.add("session-1");
      const call = (prompt: LanguageModelV4Prompt) =>
        model
          .doStream({ prompt } as LanguageModelV4CallOptions)
          .then(({ stream }) => drain(stream));
      if (priorTurn) await call([userMessage("earlier")]);
      const output = JSON.stringify({
        detail: "x".repeat(5000),
        summary: "COMPLETED_RESULT",
      });
      await call([
        ...(priorTurn
          ? [userMessage("earlier"), assistantMessage("reply")]
          : []),
        userMessage("Run the requested workflow"),
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
      const query = script.queries.at(-1)!;
      expect(query.options.resume).toBeUndefined();
      expect(query.content).toEqual([
        {
          type: "text",
          text: `Conversation so far:\n\n${priorTurn ? "Human: earlier\n\nAssistant: reply\n\n" : ""}Human: Run the requested workflow\n\n[Tool call: workflow({"topic":"tea","round":2})]\n\n[Tool result: workflow -> ${output}]\n\nHuman:`,
        },
        { type: "text", text: "Continue from the conversation above." },
      ]);
    },
  );

  it("does not resume a session the CLI no longer has", async () => {
    const { model } = setup();
    const turn: Scenario = async function* () {
      yield init("gone-session");
      yield* streamed(0, "text", "reply");
      yield result();
    };
    script.scenarios.push(turn, turn);
    const call = (prompt: LanguageModelV4Prompt) =>
      model
        .doStream({ prompt } as LanguageModelV4CallOptions)
        .then(({ stream }) => drain(stream));
    await call([userMessage("one")]);
    await call([
      userMessage("one"),
      assistantMessage("reply"),
      userMessage("two"),
    ]);
    expect(script.queries[1]!.options.resume).toBeUndefined();
    expect(script.queries[1]!.content).toEqual([
      {
        type: "text",
        text: "Conversation so far:\n\nHuman: one\n\nAssistant: reply\n\nHuman:",
      },
      { type: "text", text: "two" },
    ]);
  });

  it("interrupts the query on abort and closes with an interrupted finish", async () => {
    const { model } = setup();
    const controller = new AbortController();
    script.scenarios.push(async function* ({ interrupted }) {
      yield init();
      yield event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      yield event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      });
      setImmediate(() => controller.abort());
      await interrupted;
      yield user([{ type: "text", text: "[Request interrupted by user]" }]);
      yield result({
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: null,
      });
      throw new Error("Claude Code returned an error result");
    });
    const { stream } = await model.doStream({
      prompt: [userMessage("go")],
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    const parts = await drain(stream);
    expect(script.queries[0]!.interrupt).toHaveBeenCalledTimes(1);
    expect(parts.filter((part) => part.type === "text-end")).toHaveLength(1);
    expect(parts.filter((part) => part.type === "error")).toHaveLength(0);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "interrupted" },
    });
  });

  it("reports an SDK stream ending without a result as an error", async () => {
    const { model } = setup();
    script.scenarios.push(async function* () {
      yield init();
    });
    const events = await collect(
      conformProviderStream(
        run(model, [{ role: "user", content: "hello" }]).fullStream,
      ),
    );
    expect(events).toContainEqual({
      type: "error",
      error: expect.objectContaining({
        message: "Claude Code stopped without a result",
      }),
      providerMetadata: undefined,
    });
  });

  it("reports native result errors with their message instead of silently finishing", async () => {
    const { model } = setup();
    script.scenarios.push(async function* () {
      yield init();
      yield result({
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Turn limit reached"],
        stop_reason: null,
      });
    });
    const first = await drain(
      (
        await model.doStream({
          prompt: [userMessage("go")],
        } as LanguageModelV4CallOptions)
      ).stream,
    );
    expect(first.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "length", raw: "error_max_turns" },
    });
    expect(first).toContainEqual({
      type: "error",
      error: expect.objectContaining({ message: "Turn limit reached" }),
    });

    script.scenarios.push(async function* () {
      yield init();
      yield result({
        is_error: true,
        result: "Fable requires usage credits",
      });
    });
    const events = await collect(
      conformProviderStream(
        run(model, [{ role: "user", content: "use Fable" }]).fullStream,
      ),
    );
    expect(events).toContainEqual({
      type: "error",
      error: expect.objectContaining({
        message: "Fable requires usage credits",
      }),
      providerMetadata: undefined,
    });

    script.scenarios.push(async function* () {
      yield init();
      throw new Error("process exited");
    });
    await expect(
      drain(
        (
          await model.doStream({
            prompt: [userMessage("third")],
          } as LanguageModelV4CallOptions)
        ).stream,
      ),
    ).rejects.toThrow("process exited");
  });

  it("emits only the structured output in JSON mode and hides the internal tool", async () => {
    const { model } = setup();
    script.scenarios.push(async function* () {
      yield init();
      yield* streamed(0, "text", "Let me think");
      yield toolUse("so_1", "StructuredOutput", { answer: 4 });
      yield toolResult("so_1", "ok");
      yield result({
        stop_reason: "tool_use",
        structured_output: { answer: 4 },
      });
    });
    const schema = {
      type: "object",
      properties: { answer: { type: "number" } },
    };
    const parts = await drain(
      (
        await model.doStream({
          prompt: [userMessage("2+2")],
          responseFormat: { type: "json", schema },
        } as LanguageModelV4CallOptions)
      ).stream,
    );
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta),
    ).toEqual(['{"answer":4}']);
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(script.queries[0]!.options.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });
  });

  it("discovers models only when the CLI is logged in", async () => {
    const { provider } = setup();
    await expect(provider.discoverModels()).resolves.toEqual(script.models);
    script.auth = { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
    await expect(provider.discoverModels()).resolves.toBeUndefined();
    script.auth = { code: 2, stdout: "" };
    await expect(provider.discoverModels()).rejects.toThrow();
  });

  it("reads plan usage without a prompt or transcript scan, only when logged in", async () => {
    const { provider } = setup();
    await expect(provider.readUsage()).resolves.toEqual(script.usage);
    expect(script.usageReads).toEqual([{ skipBehaviors: true }]);
    expect(script.queries.at(-1)!.content).toBeUndefined();
    script.auth = { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
    await expect(provider.readUsage()).resolves.toBeUndefined();
    expect(script.usageReads).toHaveLength(1);
  });
});
