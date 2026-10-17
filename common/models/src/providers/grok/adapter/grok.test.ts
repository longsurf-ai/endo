// Purpose: Drives the Grok adapter against a scripted fake ACP agent through the real AI SDK stream, conformer, and host MCP server.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { streamText, type ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import { createGrokProvider } from "./provider";

/**
 * The fake agent speaks ACP on stdio. Each process records every request it
 * receives, then answers `session/prompt` by playing the next scripted
 * scenario. `callTool` reaches OpenChart tools the way Grok does: over HTTP,
 * with the bearer header from the session's `mcpServers` entry.
 */
const FAKE_AGENT = `
import fs from "node:fs";
import readline from "node:readline";

const dir = process.env.FAKE_GROK_DIR;
const queue = JSON.parse(fs.readFileSync(dir + "/scenarios.json", "utf8"));
const scenario = queue.shift() ?? { steps: [] };
fs.writeFileSync(dir + "/scenarios.json", JSON.stringify(queue));
const record = (entry) => fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(entry) + "\\n");
record({ argv: process.argv.slice(2), cwd: process.cwd(), env: {
  autoUpdate: process.env.GROK_DISABLE_AUTOUPDATER,
  claudeMcps: process.env.GROK_CLAUDE_MCPS_ENABLED,
} });

const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = ++nextId;
  waiting.set(id, resolve);
  out({ id, method, params });
});
let session = "session-new";
let servers = [];
let cancelled = false;
const cancelWaiters = [];

async function callTool(name, args) {
  const server = servers[0];
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
  const post = (body, extra = headers) => fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  const denied = (await post({ id: 0, method: "tools/list" }, {})).status;
  const initialize = await (await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  const notified = (await post({ method: "notifications/initialized" })).status;
  const listed = await (await post({ id: 2, method: "tools/list" })).json();
  const called = await (await post({ id: 3, method: "tools/call", params: { name, arguments: args } })).json();
  fs.appendFileSync(dir + "/mcp.jsonl", JSON.stringify({ denied, initialize, notified, listed, called }) + "\\n");
}

async function play(id) {
  for (const step of scenario.steps) {
    if (step.update) out({ method: "session/update", params: { sessionId: step.session ?? session, update: step.update } });
    else if (step.notice) out({ method: "_x.ai/session_notification", params: { sessionId: session, update: step.notice } });
    else if (step.callTool) await callTool(step.callTool.name, step.callTool.arguments);
    else if (step.permission) record({ permission: await ask("session/request_permission", { sessionId: session, ...step.permission }) });
    else if (step.question) record({ question: await ask("_x.ai/ask_user_question", { sessionId: session, ...step.question }) });
    else if (step.untilCancelled) {
      if (!cancelled) await new Promise((resolve) => cancelWaiters.push(resolve));
      return out({ id, result: { stopReason: "cancelled" } });
    }
    else if (step.stderr) process.stderr.write(step.stderr);
    else if (step.exit !== undefined) process.exit(step.exit);
    else if (step.result) return out({ id, result: step.result });
  }
  out({ id, result: { stopReason: "end_turn" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result ?? message.error);
    return;
  }
  record({ method: message.method, params: message.params });
  const reply = (result) => out({ id: message.id, result });
  const fail = (code, text) => out({ id: message.id, error: { code, message: text } });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    case "_x.ai/auth/check_subscription":
      return reply(scenario.subscription ?? { authenticated: true, meta: { auth_mode: "Oidc" } });
    case "_x.ai/models/list":
      return reply({ result: { currentModelId: "grok-4.7", availableModels: scenario.models ?? [] } });
    case "_x.ai/billing":
      return scenario.billing ? reply(scenario.billing) : fail(-32000, "Authentication required");
    case "session/new":
      servers = message.params.mcpServers;
      return reply({ sessionId: session });
    case "session/resume":
      if (scenario.resumeError) return fail(-32002, "Session not found");
      session = message.params.sessionId;
      servers = message.params.mcpServers;
      return reply({});
    case "session/set_config_option":
      return reply({ configOptions: [] });
    case "session/prompt":
      return void play(message.id);
    case "session/cancel":
      cancelled = true;
      return cancelWaiters.splice(0).forEach((resolve) => resolve());
    default:
      return fail(-32601, "Method not found");
  }
});
`;

type Step = Record<string, unknown>;
interface Scenario {
  steps?: Step[];
  resumeError?: boolean;
  models?: unknown[];
  subscription?: unknown;
  billing?: unknown;
}

let directory: string;
let executable: string;
const providers: Array<ReturnType<typeof createGrokProvider>> = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "grok-test-"));
  executable = path.join(directory, "grok");
  await writeFile(executable, `#!${process.execPath}\n${FAKE_AGENT}`);
  await chmod(executable, 0o755);
  await script();
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
  await rm(directory, { recursive: true, force: true });
});

async function script(...scenarios: Scenario[]) {
  await writeFile(
    path.join(directory, "scenarios.json"),
    JSON.stringify(scenarios),
  );
}

interface Call {
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  method?: string;
  params?: Record<string, unknown>;
  permission?: unknown;
  question?: unknown;
}

async function records<T>(name: string): Promise<T[]> {
  const text = await readFile(path.join(directory, name), "utf8").catch(
    () => "",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function requests(method: string) {
  return (await records<Call>("calls.jsonl")).filter(
    (call) => call.method === method,
  );
}

function setup(modelId = "grok-4.7") {
  const provider = createGrokProvider({
    executable,
    env: {
      FAKE_GROK_DIR: directory,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_CLAUDE_MCPS_ENABLED: "0",
    },
  });
  providers.push(provider);
  return { provider, model: provider.languageModel(modelId) };
}

// Native event builders

const update = (fields: Step, session?: string): Step => ({
  update: fields,
  ...(session ? { session } : {}),
});
const say = (text: string, session?: string) =>
  update(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    session,
  );
const think = (text: string, session?: string) =>
  update(
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
    session,
  );
const toolCall = (
  id: string,
  name: string,
  rawInput: unknown,
  session?: string,
) =>
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: name,
      rawInput,
      _meta: { "x.ai/tool": { name } },
    },
    session,
  );
const toolDone = (
  id: string,
  fields: Step = {},
  session?: string,
  status = "completed",
) =>
  update(
    { sessionUpdate: "tool_call_update", toolCallId: id, status, ...fields },
    session,
  );
const result = (fields: Step = {}): Step => ({
  result: { stopReason: "end_turn", ...fields },
});
const usage = (values: Record<string, number>) => ({
  _meta: { usage: values },
});

// Stream helpers

function compact(events: ModelStreamEvent[]): string[] {
  return events.flatMap((part) => {
    const owner = part.providerMetadata?.openchart?.delegateCallId;
    const at = owner ? `@${owner}` : "";
    switch (part.type) {
      case "text-delta":
        return [`text${at}:${part.text}`];
      case "reasoning-delta":
        return [`reasoning${at}:${part.text}`];
      case "tool-call":
        return [`tool-call${at}:${part.toolName}`];
      case "tool-result":
        return [`tool-result${at}:${part.toolName}`];
      case "tool-error":
        return [`tool-error${at}:${part.toolName}`];
      case "start-step":
        return owner ? [`start-step${at}`] : [];
      case "finish-step":
        return owner ? [`finish-step${at}`] : [];
      case "finish":
        return [`finish:${part.finishReason}`];
      default:
        return [];
    }
  });
}

async function run(
  model: ReturnType<typeof setup>["model"],
  messages: ModelMessage[],
  extra: { system?: string; options?: Record<string, unknown> } = {},
) {
  const stream = streamText({
    model,
    messages,
    system: extra.system,
    maxRetries: 0,
    providerOptions: {
      grok: { cwd: directory, effort: "low", ...extra.options },
    } as never,
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of conformProviderStream(stream.fullStream))
    events.push(event);
  return events;
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

const secretTool = {
  get_secret: {
    description: "Returns the secret.",
    inputSchema: z.object({ hint: z.string().optional() }),
    execute: async (input: unknown) => ({
      title: "Secret",
      value: "pineapple-42",
      input,
    }),
    toModelOutput: (output: unknown) => (output as { value: string }).value,
  },
};

describe("Grok adapter", () => {
  it("runs one ACP turn with the model, effort, cwd and hermetic environment, and reports usage", async () => {
    await script({
      steps: [
        think("Plan"),
        say("Hel"),
        say("lo"),
        result(
          usage({
            inputTokens: 500,
            outputTokens: 30,
            cachedReadTokens: 400,
            cacheCreationTokens: 0,
            reasoningTokens: 20,
          }),
        ),
      ],
    });
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "hi" }], {
      system: "Be brief.",
    });
    expect(compact(events)).toEqual([
      "reasoning:Plan",
      "text:Hel",
      "text:lo",
      "finish:stop",
    ]);
    expect(events.find((event) => event.type === "finish-step")).toMatchObject({
      usage: {
        inputTokens: 500,
        outputTokens: 30,
        inputTokenDetails: {
          noCacheTokens: 100,
          cacheReadTokens: 400,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 10, reasoningTokens: 20 },
      },
    });
    const calls = await records<Call>("calls.jsonl");
    expect(calls[0]).toMatchObject({
      argv: ["agent", "--no-leader", "stdio"],
      cwd: await import("node:fs/promises").then((fs) =>
        fs.realpath(directory),
      ),
      env: { autoUpdate: "1", claudeMcps: "0" },
    });
    expect(calls.map((call) => call.method).filter(Boolean)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    const [created] = await requests("session/new");
    expect(created!.params).toEqual({
      cwd: directory,
      mcpServers: [],
      _meta: { rules: "Be brief." },
    });
    expect(
      (await requests("session/set_config_option")).map((call) => call.params),
    ).toEqual([
      { sessionId: "session-new", configId: "model", value: "grok-4.7" },
      { sessionId: "session-new", configId: "reasoning_effort", value: "low" },
    ]);
    const [prompted] = await requests("session/prompt");
    expect(prompted!.params).toEqual({
      sessionId: "session-new",
      prompt: [
        { type: "text", text: "" },
        { type: "text", text: "hi" },
      ],
    });
  });

  it("keeps a leading slash literal and maps permission modes onto the session", async () => {
    await script({ steps: [say("ok")] }, { steps: [say("ok")] });
    const { model } = setup();
    await run(model, [{ role: "user", content: "/compact now" }], {
      options: { permissionMode: "always-approve" },
    });
    await run(model, [{ role: "user", content: "/compact again" }], {
      options: { permissionMode: "auto" },
    });
    const created = await requests("session/new");
    expect(created.map((call) => call.params!._meta)).toEqual([
      { yoloMode: true },
      { autoMode: true },
    ]);
    const [prompted] = await requests("session/prompt");
    expect(prompted!.params!.prompt).toEqual([
      { type: "text", text: "" },
      { type: "text", text: "/compact now" },
    ]);
  });

  it("resumes an append-only conversation with only the new message and replays everything else", async () => {
    await script(
      { steps: [say("ACK")] },
      { steps: [say("7312")] },
      { steps: [say("narwhal")] },
      { resumeError: true, steps: [say("again")] },
    );
    const { model } = setup();
    const opening: ModelMessage[] = [
      { role: "user", content: "The number is 7312. Reply ACK." },
    ];
    await run(model, opening, { system: "Be brief." });
    const followUp: ModelMessage[] = [
      ...opening,
      { role: "assistant", content: "ACK" },
      { role: "user", content: "What was the number?" },
    ];
    await run(model, followUp, { system: "Be brief." });
    // An edited prior turn misses and replays the transcript into a new session.
    await run(
      model,
      [
        { role: "user", content: "The animal is a narwhal. Reply ACK." },
        { role: "assistant", content: "ACK" },
        { role: "user", content: "Which animal?" },
      ],
      { system: "Be brief." },
    );
    const prompts = await requests("session/prompt");
    expect(prompts.map((call) => call.params!.prompt)).toEqual([
      [
        { type: "text", text: "" },
        { type: "text", text: "The number is 7312. Reply ACK." },
      ],
      [
        { type: "text", text: "" },
        { type: "text", text: "What was the number?" },
      ],
      [
        { type: "text", text: "" },
        {
          type: "text",
          text: "Conversation so far:\n\nHuman: The animal is a narwhal. Reply ACK.\n\nAssistant: ACK\n\nHuman: Which animal?",
        },
      ],
    ]);
    const [resumed] = await requests("session/resume");
    expect(resumed!.params).toEqual({
      sessionId: "session-new",
      cwd: directory,
      mcpServers: [],
      _meta: {},
    });
    const sessions = await requests("session/new");
    expect(sessions).toHaveLength(2);
    // Only a session that starts from replayed text is told the replay is real history.
    expect(sessions.map((call) => call.params!._meta)).toEqual([
      { rules: "Be brief." },
      {
        rules: expect.stringMatching(
          /^Be brief\.\n\nThe first message replays this conversation's earlier turns/,
        ),
      },
    ]);

    // A remembered session that no longer exists falls back to a fresh replay.
    await run(
      model,
      [
        { role: "user", content: "The animal is a narwhal. Reply ACK." },
        { role: "assistant", content: "ACK" },
        { role: "user", content: "Which animal?" },
        { role: "assistant", content: "narwhal" },
        { role: "user", content: "Again?" },
      ],
      { system: "Be brief." },
    );
    const last = (await requests("session/prompt")).at(-1)!;
    expect(last.params!.prompt).toEqual([
      { type: "text", text: "" },
      {
        type: "text",
        text: "Conversation so far:\n\nHuman: The animal is a narwhal. Reply ACK.\n\nAssistant: ACK\n\nHuman: Which animal?\n\nAssistant: narwhal\n\nHuman: Again?",
      },
    ]);
  });

  it("serves OpenChart tools over authenticated HTTP MCP with exact outcomes and hides the plumbing", async () => {
    await script({
      steps: [
        toolCall("call-search", "search_tool", { query: "secret" }),
        toolDone("call-search", { rawOutput: { results: [] } }),
        toolCall("call-use", "use_tool", {
          tool_name: "openchart__get_secret",
          tool_input: { hint: "fruit" },
        }),
        { callTool: { name: "get_secret", arguments: { hint: "fruit" } } },
        toolDone("call-use", { rawOutput: { type: "MCP" } }),
        say("pineapple-42"),
      ],
    });
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "secret?" }], {
      options: { tools: secretTool, permissionMode: "always-approve" },
    });
    expect(compact(events)).toEqual([
      "tool-call:get_secret",
      "tool-result:get_secret",
      "text:pineapple-42",
      "finish:stop",
    ]);
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      providerExecuted: true,
      output: {
        title: "Secret",
        value: "pineapple-42",
        input: { hint: "fruit" },
      },
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    const [exchange] = await records<{
      denied: number;
      notified: number;
      listed: { result: { tools: Array<{ name: string }> } };
      called: { result: unknown };
    }>("mcp.jsonl");
    expect(exchange!.denied).toBe(401);
    expect(exchange!.notified).toBe(202);
    expect(exchange!.listed.result.tools.map((tool) => tool.name)).toEqual([
      "get_secret",
    ]);
    expect(exchange!.called.result).toEqual({
      content: [{ type: "text", text: "pineapple-42" }],
    });
    const [created] = await requests("session/new");
    expect(created!.params).toMatchObject({
      mcpServers: [
        {
          type: "http",
          name: "openchart",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
          headers: [
            { name: "Authorization", value: expect.stringMatching(/^Bearer /) },
          ],
        },
      ],
      _meta: {
        yoloMode: true,
        rules: expect.stringContaining("openchart__get_secret"),
      },
    });
  });

  it("emits native tools, including X search, as provider-executed calls", async () => {
    await script({
      steps: [
        update({
          sessionUpdate: "tool_call",
          toolCallId: "xs-1",
          title: "X search:",
          kind: "search",
          rawInput: { variant: "XSearch", backend: true },
        }),
        toolDone("xs-1", {
          rawOutput: {
            name: "x_keyword_search",
            input: '{"query":"from:xai","mode":"Latest"}',
          },
        }),
        toolCall("bash-1", "run_terminal_command", { command: "ls" }),
        toolDone("bash-1", {
          content: [
            { type: "content", content: { type: "text", text: "a\nb\n" } },
          ],
          rawOutput: { type: "Bash", exit_code: 0 },
        }),
        toolCall("bad-1", "read_file", { path: "/missing" }),
        toolDone(
          "bad-1",
          { rawOutput: { error: "not found" } },
          undefined,
          "failed",
        ),
        say("done"),
      ],
    });
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "go" }], {
      options: { permissionMode: "always-approve" },
    });
    expect(compact(events)).toEqual([
      "tool-call:x_search",
      "tool-result:x_search",
      "tool-call:run_terminal_command",
      "tool-result:run_terminal_command",
      "tool-call:read_file",
      "tool-error:read_file",
      "text:done",
      "finish:stop",
    ]);
    const outputs = events.filter((event) => event.type === "tool-result");
    expect(outputs[0]).toMatchObject({
      providerExecuted: true,
      input: { variant: "XSearch", backend: true },
      output: {
        output: {
          name: "x_keyword_search",
          input: '{"query":"from:xai","mode":"Latest"}',
        },
        attachments: [],
      },
    });
    expect(outputs[1]).toMatchObject({ output: { output: "a\nb" } });
  });

  it("streams foreground subagents as nested delegates sealed before their proxy results", async () => {
    await script({
      steps: [
        say("Delegating"),
        toolCall("spawn-a", "spawn_subagent", {
          description: "count files",
          prompt: "Run ls.",
          background: false,
        }),
        {
          notice: {
            sessionUpdate: "subagent_spawned",
            parent_session_id: "session-new",
            child_session_id: "child-a",
            description: "count files",
            subagent_type: "general-purpose",
          },
        },
        update(
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Run ls." },
          },
          "child-a",
        ),
        think("listing", "child-a"),
        toolCall("ls-1", "run_terminal_command", { command: "ls" }, "child-a"),
        toolCall(
          "spawn-b",
          "spawn_subagent",
          { description: "nested", prompt: "Say hi." },
          "child-a",
        ),
        {
          notice: {
            sessionUpdate: "subagent_spawned",
            parent_session_id: "child-a",
            child_session_id: "child-b",
            description: "nested",
          },
        },
        say("hi", "child-b"),
        {
          notice: {
            sessionUpdate: "subagent_finished",
            child_session_id: "child-b",
            status: "completed",
          },
        },
        toolDone(
          "spawn-b",
          { rawOutput: { type: "SubagentCompleted", output: "hi" } },
          "child-a",
        ),
        toolDone(
          "ls-1",
          {
            content: [
              { type: "content", content: { type: "text", text: "2" } },
            ],
          },
          "child-a",
        ),
        say("2 files", "child-a"),
        // A background spawn returns at once and its session stays hidden.
        toolCall("spawn-bg", "spawn_subagent", {
          description: "watch",
          prompt: "Watch.",
          background: true,
        }),
        {
          notice: {
            sessionUpdate: "subagent_spawned",
            parent_session_id: "session-new",
            child_session_id: "child-bg",
            description: "watch",
          },
        },
        say("hidden", "child-bg"),
        toolDone("spawn-bg", { rawOutput: { type: "Task", task_id: "t1" } }),
        {
          notice: {
            sessionUpdate: "subagent_finished",
            child_session_id: "child-a",
            status: "completed",
          },
        },
        toolDone("spawn-a", {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "2 files\n<subagent_meta>…</subagent_meta>",
              },
            },
          ],
          rawOutput: { type: "SubagentCompleted", output: "2 files" },
        }),
        say("The subagent found 2 files."),
      ],
    });
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "count" }], {
      options: { permissionMode: "always-approve" },
    });
    expect(compact(events)).toEqual([
      "text:Delegating",
      "tool-call:spawn_subagent",
      "start-step@spawn-a",
      "reasoning@spawn-a:listing",
      "tool-call@spawn-a:run_terminal_command",
      "tool-call@spawn-a:spawn_subagent",
      "start-step@spawn-b",
      "text@spawn-b:hi",
      "finish-step@spawn-b",
      "tool-result@spawn-a:spawn_subagent",
      "tool-result@spawn-a:run_terminal_command",
      "text@spawn-a:2 files",
      "tool-call:spawn_subagent",
      "tool-result:spawn_subagent",
      "finish-step@spawn-a",
      "tool-result:spawn_subagent",
      "text:The subagent found 2 files.",
      "finish:stop",
    ]);
    expect(
      events.find(
        (event) => event.type === "tool-call" && event.toolCallId === "spawn-a",
      ),
    ).toMatchObject({
      providerMetadata: {
        openchart: {
          openDelegate: {
            description: "count files",
            prompt: "Run ls.",
            agent: "general-purpose",
          },
        },
      },
    });
    expect(
      events.find(
        (event) =>
          event.type === "tool-result" && event.toolCallId === "spawn-a",
      ),
    ).toMatchObject({ output: { output: "2 files" } });
  });

  it("seals delegates that never report back when the turn ends", async () => {
    await script({
      steps: [
        toolCall("spawn-a", "spawn_subagent", {
          description: "stuck",
          prompt: "Wait.",
        }),
        {
          notice: {
            sessionUpdate: "subagent_spawned",
            parent_session_id: "session-new",
            child_session_id: "child-a",
            description: "stuck",
          },
        },
        toolCall(
          "ls-1",
          "run_terminal_command",
          { command: "sleep 9" },
          "child-a",
        ),
        result({ stopReason: "end_turn" }),
      ],
    });
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "go" }], {
      options: { permissionMode: "always-approve" },
    });
    expect(compact(events)).toEqual([
      "tool-call:spawn_subagent",
      "start-step@spawn-a",
      "tool-call@spawn-a:run_terminal_command",
      "tool-error@spawn-a:run_terminal_command",
      "finish-step@spawn-a",
      "tool-error:spawn_subagent",
      "finish:stop",
    ]);
  });

  it("asks the host for native approvals and pre-approves OpenChart tools", async () => {
    const options = [
      { optionId: "always-allow", name: "Always", kind: "allow_always" },
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "reject-once", name: "No", kind: "reject_once" },
    ];
    await script({
      steps: [
        {
          permission: {
            toolCall: {
              toolCallId: "bash-1",
              title: "Execute `rm x`",
              kind: "execute",
              rawInput: { variant: "Bash", command: "rm x" },
            },
            options,
          },
        },
        {
          permission: {
            toolCall: {
              toolCallId: "bash-2",
              title: "Execute `curl`",
              kind: "execute",
              rawInput: { variant: "Bash", command: "curl" },
            },
            options,
          },
        },
        {
          permission: {
            toolCall: {
              toolCallId: "use-1",
              title: "openchart__get_secret",
              kind: "other",
              rawInput: { tool_name: "openchart__get_secret" },
            },
            options,
          },
        },
        say("ok"),
      ],
    });
    const asked: unknown[] = [];
    const { model } = setup();
    await run(model, [{ role: "user", content: "go" }], {
      options: {
        approve: async (request: { input: { command?: string } }) => {
          asked.push(request);
          return request.input.command === "rm x";
        },
      },
    });
    expect(asked).toEqual([
      {
        kind: "execute",
        title: "Execute `rm x`",
        input: { variant: "Bash", command: "rm x" },
      },
      {
        kind: "execute",
        title: "Execute `curl`",
        input: { variant: "Bash", command: "curl" },
      },
    ]);
    const decisions = (await records<Call>("calls.jsonl"))
      .filter((call) => call.permission)
      .map((call) => call.permission);
    expect(decisions).toEqual([
      { outcome: { outcome: "selected", optionId: "allow-once" } },
      { outcome: { outcome: "selected", optionId: "reject-once" } },
      { outcome: { outcome: "selected", optionId: "allow-once" } },
    ]);
  });

  it("answers ask_user_question through the host, and skips without one", async () => {
    const question = {
      toolCallId: "ask-1",
      questions: [
        {
          question: "Which color?",
          options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
          multiSelect: null,
        },
      ],
    };
    await script(
      { steps: [{ question }, say("Blue")] },
      { steps: [{ question }, say("skipped")] },
    );
    const asked: unknown[] = [];
    const { model } = setup();
    await run(model, [{ role: "user", content: "ask" }], {
      options: {
        answer: async (request: unknown) => {
          asked.push(request);
          return { "Which color?": "Blue" };
        },
      },
    });
    await run(model, [{ role: "user", content: "ask again" }]);
    expect(asked).toEqual([
      {
        questions: [
          {
            question: "Which color?",
            options: [
              { label: "Red", description: "Warm" },
              { label: "Blue", description: "" },
            ],
            multiSelect: false,
          },
        ],
      },
    ]);
    const answers = (await records<Call>("calls.jsonl"))
      .filter((call) => call.question)
      .map((call) => call.question);
    expect(answers).toEqual([
      { outcome: "accepted", answers: { "Which color?": "Blue" } },
      { outcome: "skip_interview" },
    ]);
  });

  it("requests structured output and emits only the structured value", async () => {
    await script(
      {
        steps: [
          say("I'll answer."),
          result({ _meta: { structuredOutput: { city: "Paris" } } }),
        ],
      },
      { steps: [result({ _meta: { structuredOutputError: "invalid" } })] },
    );
    const { model } = setup();
    const schema = {
      type: "object" as const,
      properties: { city: { type: "string" as const } },
    };
    const call = {
      prompt: [user("capital?")],
      responseFormat: { type: "json" as const, schema },
      providerOptions: { grok: { cwd: directory } },
    };
    const parts = await drain((await model.doStream(call)).stream);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta),
    ).toEqual(['{"city":"Paris"}']);
    const [prompted] = await requests("session/prompt");
    expect(prompted!.params!._meta).toEqual({ outputSchema: schema });

    const failed = await drain((await model.doStream(call)).stream);
    expect(failed.find((part) => part.type === "error")).toMatchObject({
      error: { message: expect.stringContaining("no structured output") },
    });
    expect(failed.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "error" },
    });
  });

  it("cancels the session on abort and finishes as interrupted", async () => {
    await script({ steps: [say("Once upon"), { untilCancelled: true }] });
    const { model } = setup();
    const controller = new AbortController();
    const { stream } = await model.doStream({
      prompt: [user("story")],
      abortSignal: controller.signal,
      providerOptions: { grok: { cwd: directory } },
    });
    const parts: LanguageModelV4StreamPart[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (value.type === "text-delta") controller.abort();
    }
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "interrupted" },
    });
    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(await requests("session/cancel")).toHaveLength(1);
  });

  it("fails the turn with the agent's stderr when it exits mid-turn", async () => {
    await script({
      steps: [say("partial"), { stderr: "panic: boom\n" }, { exit: 3 }],
    });
    const { model } = setup();
    const parts = await drain(
      (
        await model.doStream({
          prompt: [user("go")],
          providerOptions: { grok: { cwd: directory } },
        })
      ).stream,
    );
    expect(parts.find((part) => part.type === "error")).toMatchObject({
      error: { message: expect.stringContaining("panic: boom") },
    });
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "error" },
    });
  });

  it("discovers models and plan usage without creating a session", async () => {
    const models = [{ modelId: "grok-4.7", name: "Grok 4.7" }];
    const billing = {
      config: {
        creditUsagePercent: 3,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-10-23T00:00:00Z",
        },
      },
    };
    await script(
      { models },
      { models, billing },
      { subscription: { authenticated: false, meta: null } },
      { subscription: { authenticated: false, meta: null } },
    );
    const { provider } = setup();
    expect(await provider.discoverModels()).toEqual(models);
    expect(await provider.readUsage()).toMatchObject({
      subscription: { authenticated: true },
      billing,
    });
    expect(await provider.discoverModels()).toBeUndefined();
    expect(await provider.readUsage()).toBeUndefined();
    expect(await requests("session/new")).toHaveLength(0);
  });
});
