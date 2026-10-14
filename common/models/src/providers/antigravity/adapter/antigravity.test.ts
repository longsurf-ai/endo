// Purpose: Drives the Antigravity adapter against a scripted fake CLI through the real AI SDK stream, conformer, and MCP relay.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LanguageModelV4CallOptions,
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
import { createAntigravityProvider } from "./provider";

/**
 * The fake CLI records its argv, cwd and stdin, then plays the next scripted
 * scenario. `callTool` reaches OpenChart tools the way the real CLI does: it
 * starts the `openchart` relay from the MCP config the adapter wrote.
 */
const FAKE_CLI = `
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const dir = process.env.FAKE_AGY_DIR;
const queue = JSON.parse(fs.readFileSync(dir + "/scenarios.json", "utf8"));
const scenario = queue.shift() ?? [];
fs.writeFileSync(dir + "/scenarios.json", JSON.stringify(queue));
let interrupted = false;
process.on("SIGINT", () => { interrupted = true; });
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdin,
  relay: process.env.OPENCHART_AGY_MCP_PORT !== undefined,
  autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
}) + "\\n");

async function callTool(name, args) {
  const config = JSON.parse(fs.readFileSync(
    process.env.HOME + "/.gemini/config/mcp_config.json", "utf8")).mcpServers.openchart;
  const relay = spawn(config.command, config.args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  readline.createInterface({ input: relay.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method, params) => new Promise((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  });
  const initialize = await request("initialize", { protocolVersion: "2025-11-25" });
  const unknown = await request("server/discover", {});
  const listed = await request("tools/list", {});
  const called = await request("tools/call", { name, arguments: args });
  relay.stdin.end();
  relay.kill();
  fs.appendFileSync(dir + "/mcp.jsonl", JSON.stringify({ initialize, unknown, listed, called }) + "\\n");
}

const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for (const step of scenario) {
  if (step.emit) out(step.emit);
  else if (step.stdout !== undefined) process.stdout.write(step.stdout);
  else if (step.stderr !== undefined) process.stderr.write(step.stderr);
  else if (step.callTool) await callTool(step.callTool.name, step.callTool.arguments);
  else if (step.untilInterrupted) while (!interrupted) await new Promise((r) => setTimeout(r, 5));
  else if (step.exit !== undefined) process.exit(step.exit);
}
`;

type Step = Record<string, unknown>;

let directory: string;
let home: string;
let executable: string;
const providers: Array<ReturnType<typeof createAntigravityProvider>> = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
  home = path.join(directory, "home");
  await mkdir(path.join(home, ".gemini", "antigravity-cli", "conversations"), {
    recursive: true,
  });
  executable = path.join(directory, "antigravity");
  await writeFile(executable, `#!${process.execPath}\n${FAKE_CLI}`);
  await chmod(executable, 0o755);
  await script();
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
  await rm(directory, { recursive: true, force: true });
});

async function script(...scenarios: Step[][]) {
  await writeFile(
    path.join(directory, "scenarios.json"),
    JSON.stringify(scenarios),
  );
}

/** One fake CLI run as it recorded itself. */
interface CliRun {
  argv: string[];
  cwd: string;
  stdin: string;
  relay: boolean;
  autoUpdate?: string;
}

/** The fake CLI's MCP requests through the relay and their JSON-RPC replies. */
interface McpExchange {
  unknown: { error: { code: number } };
  listed: { result: { tools: unknown[] } };
  called: { result: unknown };
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

function setup(modelId = "gemini-3.1-pro") {
  const provider = createAntigravityProvider({
    executable,
    env: {
      HOME: home,
      FAKE_AGY_DIR: directory,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    },
  });
  providers.push(provider);
  return { provider, model: provider.languageModel(modelId) };
}

// Native event builders

const ZERO = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
};
const init = (conversation = "conv-1"): Step => ({
  emit: { event: "init", conversation_id: conversation, init: { tools: [] } },
});
const step = (index: number, fields: Step, conversation = "conv-1"): Step => ({
  emit: {
    event: "step_update",
    step_update: {
      conversation_id: conversation,
      step_index: index,
      ...fields,
    },
  },
});
const textDelta = (index: number, delta: string): Step =>
  step(index, {
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: delta,
  });
const responseDone = (index: number, usage: Step = ZERO): Step =>
  step(index, { state: "DONE", step_type: "agent_response", usage });
const toolStep = (index: number, state: string, toolInfo: Step): Step =>
  step(index, {
    state,
    step_type: "tool",
    tool_name: toolInfo.name,
    tool_info: toolInfo,
  });
const result = (fields: Step = {}, conversation = "conv-1"): Step => ({
  emit: {
    event: "result",
    result: {
      conversation_id: conversation,
      status: "SUCCESS",
      response: "",
      usage: ZERO,
      ...fields,
    },
  },
});
const reply = (text: string, conversation = "conv-1"): Step[] => [
  init(conversation),
  step(0, { state: "DONE", step_type: "user_input" }, conversation),
  textDelta(1, text),
  responseDone(1),
  result({ response: text }, conversation),
];

// Stream helpers

function compact(events: ModelStreamEvent[]): string[] {
  return events.flatMap((part) => {
    switch (part.type) {
      case "text-delta":
        return [`text:${part.text}`];
      case "tool-call":
        return [`tool-call:${part.toolName}`];
      case "tool-result":
        return [`tool-result:${part.toolName}`];
      case "tool-error":
        return [`tool-error:${part.toolName}`];
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
      antigravity: { cwd: directory, effort: "low", ...extra.options },
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
const assistant = (text: string): LanguageModelV4Prompt[number] => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("Antigravity adapter", () => {
  it("runs one stream-json turn with the model, effort and cwd, and reports usage", async () => {
    await script([
      init(),
      textDelta(1, "Hel"),
      textDelta(1, "lo"),
      responseDone(1, {
        input_tokens: 100,
        output_tokens: 30,
        thinking_tokens: 20,
        cache_read_tokens: 400,
      }),
      result({
        response: "Hello",
        // Result usage spans the conversation; the turn's steps win.
        usage: { ...ZERO, input_tokens: 9999 },
      }),
    ]);
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "hi" }]);
    expect(compact(events)).toEqual(["text:Hel", "text:lo", "finish:stop"]);
    const finish = events.find((event) => event.type === "finish-step");
    expect(finish).toMatchObject({
      usage: {
        inputTokens: 500,
        outputTokens: 30,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 400 },
        outputTokenDetails: { textTokens: 10, reasoningTokens: 20 },
      },
    });
    const [call] = await records<CliRun>("calls.jsonl");
    expect(call).toMatchObject({
      cwd: await import("node:fs/promises").then((fs) =>
        fs.realpath(directory),
      ),
      relay: false,
      autoUpdate: "true",
      argv: [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--disable-slash-commands",
        "--model",
        "gemini-3.1-pro",
        "--effort",
        "low",
      ],
    });
    expect(JSON.parse(call!.stdin)).toEqual({
      event: "user",
      message: { content: "hi" },
    });
  });

  it("resumes an append-only conversation with only the new message and replays everything else", async () => {
    await script(reply("ACK"), reply("7312"), reply("narwhal", "conv-2"));
    await writeFile(
      path.join(
        home,
        ".gemini",
        "antigravity-cli",
        "conversations",
        "conv-1.db",
      ),
      "",
    );
    const { model } = setup();
    const call = (prompt: LanguageModelV4Prompt) =>
      model
        .doStream({
          prompt,
          providerOptions: { antigravity: { effort: "low" } },
        } as LanguageModelV4CallOptions)
        .then(({ stream }) => drain(stream));
    const system = { role: "system", content: "Be brief." } as const;
    await call([system, user("code word amber 7312")]);
    await call([
      system,
      user("code word amber 7312"),
      assistant("ACK"),
      user("what was it?"),
    ]);
    // An edited earlier turn misses and replays the whole transcript.
    await call([
      system,
      user("the animal is a narwhal"),
      assistant("NOTED"),
      user("which animal?"),
    ]);
    const calls = await records<CliRun>("calls.jsonl");
    expect(calls.map((entry) => entry.argv.includes("--conversation"))).toEqual(
      [false, true, false],
    );
    expect(calls[1]!.argv).toContain("conv-1");
    expect(JSON.parse(calls[0]!.stdin).message.content).toBe(
      "System instructions:\nBe brief.\n\nHuman: code word amber 7312",
    );
    expect(JSON.parse(calls[1]!.stdin).message.content).toBe("what was it?");
    expect(JSON.parse(calls[2]!.stdin).message.content).toBe(
      [
        "System instructions:\nBe brief.",
        "Conversation so far:\n\nHuman: the animal is a narwhal\n\nAssistant: NOTED",
        "Human: which animal?",
      ].join("\n\n"),
    );
  });

  it("starts fresh when the remembered conversation is gone or the tools change", async () => {
    await script(
      reply("ACK"),
      reply("one"),
      reply("ACK", "conv-2"),
      reply("two", "conv-2"),
    );
    const { model } = setup();
    const call = (prompt: LanguageModelV4Prompt, tools?: unknown) =>
      model
        .doStream({
          prompt,
          providerOptions: { antigravity: { effort: "low", tools } },
        } as LanguageModelV4CallOptions)
        .then(({ stream }) => drain(stream));
    // conv-1 never reaches disk.
    await call([user("first")]);
    await call([user("first"), assistant("ACK"), user("second")]);
    await writeFile(
      path.join(
        home,
        ".gemini",
        "antigravity-cli",
        "conversations",
        "conv-2.db",
      ),
      "",
    );
    const tool = {
      noop: {
        description: "Does nothing.",
        inputSchema: z.object({}),
        execute: async () => "ok",
        toModelOutput: (output: unknown) => output,
      },
    };
    await call([user("again")]);
    await call([user("again"), assistant("ACK"), user("with tools")], tool);
    const calls = await records<CliRun>("calls.jsonl");
    expect(calls.map((entry) => entry.argv.includes("--conversation"))).toEqual(
      [false, false, false, false],
    );
  });

  it("maps native tool steps to provider-executed calls and results, including failures and subagents", async () => {
    await script([
      init(),
      toolStep(2, "ACTIVE", {
        name: "run_command",
        parameters: { CommandLine: "echo hi" },
      }),
      toolStep(2, "DONE", {
        name: "run_command",
        parameters: { CommandLine: "echo hi" },
        output: "hi\n",
      }),
      toolStep(3, "ERROR", {
        name: "view_file",
        parameters: { AbsolutePath: "/etc/hosts" },
        error: { type: "TOOL_ERROR", message: "permission denied" },
      }),
      step(4, {
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "invoke_subagent",
        tool_info: {},
        subagent_info: {
          subagents: [
            { type_name: "self", role: "Math", initial_prompt: "2+2" },
          ],
        },
      }),
      step(4, {
        state: "DONE",
        step_type: "tool",
        tool_name: "invoke_subagent",
        tool_info: {},
        subagent_info: {
          subagents: [
            {
              type_name: "self",
              role: "Math",
              initial_prompt: "2+2",
              conversation_id: "child",
            },
          ],
        },
      }),
      textDelta(5, "done"),
      responseDone(5),
      result({ response: "done" }),
    ]);
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "go" }]);
    expect(compact(events)).toEqual([
      "tool-call:run_command",
      "tool-result:run_command",
      "tool-call:view_file",
      "tool-error:view_file",
      "tool-call:invoke_subagent",
      "tool-result:invoke_subagent",
      "text:done",
      "finish:stop",
    ]);
    expect(
      events.find(
        (event) =>
          event.type === "tool-call" && event.toolName === "run_command",
      ),
    ).toMatchObject({
      providerExecuted: true,
      input: { CommandLine: "echo hi" },
    });
    expect(
      events.find(
        (event) =>
          event.type === "tool-result" && event.toolName === "run_command",
      ),
    ).toMatchObject({ output: { output: "hi\n", attachments: [] } });
    expect(
      events.find(
        (event) =>
          event.type === "tool-call" && event.toolName === "invoke_subagent",
      ),
    ).toMatchObject({
      input: { subagents: [{ role: "Math", prompt: "2+2" }] },
    });
  });

  it("serves OpenChart tools through the relay with exact outcomes and hides the CLI's plumbing", async () => {
    const mcpFile = path.join(home, ".gemini", "config", "mcp_config.json");
    await mkdir(path.dirname(mcpFile), { recursive: true });
    await writeFile(
      mcpFile,
      JSON.stringify({ mcpServers: { mine: { command: "mine" } }, other: 1 }),
    );
    await script([
      init(),
      toolStep(1, "ACTIVE", {
        name: "view_file",
        parameters: {
          AbsolutePath: `${home}/.gemini/antigravity-cli/mcp/openchart/get_secret.json`,
        },
      }),
      toolStep(1, "DONE", {
        name: "view_file",
        parameters: {
          AbsolutePath: `${home}/.gemini/antigravity-cli/mcp/openchart/get_secret.json`,
        },
        output: "1 lines",
      }),
      toolStep(2, "ACTIVE", {
        name: "call_mcp_tool",
        parameters: {
          ServerName: "openchart",
          ToolName: "get_secret",
          Arguments: {},
        },
      }),
      { callTool: { name: "get_secret", arguments: { length: 2 } } },
      toolStep(2, "DONE", {
        name: "call_mcp_tool",
        parameters: {
          ServerName: "openchart",
          ToolName: "get_secret",
          Arguments: {},
        },
        output: "pineapple-42",
      }),
      textDelta(3, "pineapple-42"),
      responseDone(3),
      result({ response: "pineapple-42" }),
    ]);
    const executed: unknown[] = [];
    const tools = {
      get_secret: {
        description: "Returns the secret phrase.",
        inputSchema: z.object({ length: z.number() }),
        execute: async (input: unknown, options: { toolCallId: string }) => {
          executed.push({ input, id: options.toolCallId });
          return { title: "Secret", value: "pineapple-42", hidden: true };
        },
        toModelOutput: (output: unknown) => (output as { value: string }).value,
      },
    };
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "secret?" }], {
      options: { tools },
    });
    expect(compact(events)).toEqual([
      "tool-call:get_secret",
      "tool-result:get_secret",
      "text:pineapple-42",
      "finish:stop",
    ]);
    const call = events.find((event) => event.type === "tool-call");
    expect(call).toMatchObject({
      providerExecuted: true,
      input: { length: 2 },
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      output: { title: "Secret", value: "pineapple-42", hidden: true },
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    expect(executed).toEqual([
      { input: { length: 2 }, id: (call as { toolCallId: string }).toolCallId },
    ]);
    const [mcp] = await records<McpExchange>("mcp.jsonl");
    expect(mcp!.unknown.error.code).toBe(-32601);
    expect(mcp!.listed.result.tools).toEqual([
      expect.objectContaining({
        name: "get_secret",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);
    expect(mcp!.called.result).toEqual({
      content: [{ type: "text", text: "pineapple-42" }],
    });
    const [record] = await records<CliRun>("calls.jsonl");
    expect(record!.relay).toBe(true);
    // The user's own servers and keys survive; the relay and rules are added.
    const config = JSON.parse(await readFile(mcpFile, "utf8"));
    expect(config.other).toBe(1);
    expect(Object.keys(config.mcpServers)).toEqual(["mine", "openchart"]);
    // OpenChart owns tool timeouts; the CLI's 3-minute default is lifted.
    expect(config.mcpServers.openchart.timeoutSeconds).toBe(7200);
    const settings = JSON.parse(
      await readFile(
        path.join(home, ".gemini", "antigravity-cli", "settings.json"),
        "utf8",
      ),
    );
    const realHome = await import("node:fs/promises").then((fs) =>
      fs.realpath(home),
    );
    expect(settings.permissions.allow).toEqual([
      "mcp(openchart/*)",
      `read_file(${realHome}/.gemini/antigravity-cli/mcp/openchart/)`,
    ]);
  });

  it("reports a failed OpenChart tool once and never shows the CLI's plumbing", async () => {
    await script([
      init(),
      { callTool: { name: "explode", arguments: {} } },
      // The CLI's own step repeats the outcome the host already reported.
      toolStep(2, "ERROR", {
        name: "call_mcp_tool",
        parameters: {
          ServerName: "openchart",
          ToolName: "explode",
          Arguments: {},
        },
        error: { type: "TOOL_ERROR", message: "boom" },
      }),
      result(),
    ]);
    const tools = {
      explode: {
        description: "Fails.",
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error("boom");
        },
        toModelOutput: (output: unknown) => output,
      },
    };
    const { model } = setup();
    const events = await run(model, [{ role: "user", content: "go" }], {
      options: { tools },
    });
    expect(compact(events)).toEqual([
      "tool-call:explode",
      "tool-error:explode",
      "finish:stop",
    ]);
    const [mcp] = await records<McpExchange>("mcp.jsonl");
    expect(mcp!.called.result).toEqual({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });

  it("passes full access as --dangerously-skip-permissions and a JSON schema as structured output", async () => {
    await script([
      init(),
      textDelta(1, '{"city":'),
      responseDone(1),
      result({ structured_output: { city: "Paris" } }),
    ]);
    const { model } = setup();
    const { content } = await model.doGenerate({
      prompt: [user("capital of France")],
      providerOptions: {
        antigravity: { effort: "low", skipPermissions: true },
      },
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { city: { type: "string" } } },
      },
    } as LanguageModelV4CallOptions);
    // Streamed prose is replaced by the final structured output.
    expect(content).toEqual([{ type: "text", text: '{"city":"Paris"}' }]);
    const [call] = await records<CliRun>("calls.jsonl");
    expect(call!.argv).toEqual(
      expect.arrayContaining([
        "--dangerously-skip-permissions",
        "--json-schema",
        JSON.stringify({
          type: "object",
          properties: { city: { type: "string" } },
        }),
      ]),
    );
  });

  it("interrupts on abort with SIGINT and finishes as interrupted", async () => {
    await script([
      init(),
      textDelta(1, "partial"),
      { untilInterrupted: true },
      result({ status: "ERROR", error: "interrupted" }),
      { exit: 1 },
    ]);
    const { model } = setup();
    const controller = new AbortController();
    const { stream } = await model.doStream({
      prompt: [user("write at length")],
      abortSignal: controller.signal,
      providerOptions: { antigravity: { effort: "low" } },
    } as LanguageModelV4CallOptions);
    const reader = stream.getReader();
    const parts: LanguageModelV4StreamPart[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (value.type === "text-delta") controller.abort();
    }
    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "interrupted" },
    });
  });

  it("turns failed results, denied actions and exits without a result into stream errors", async () => {
    await script(
      [
        init(),
        result({ status: "ERROR", error: "quota exhausted" }),
        { exit: 3 },
      ],
      // Headless mode cannot ask: the turn ends "successfully" at the first denial.
      [
        init(),
        toolStep(2, "DONE", {
          name: "run_command",
          parameters: { CommandLine: "date" },
        }),
        result({
          denied_actions: [{ action: "command", display_name: "RunCommand" }],
        }),
      ],
      [{ stderr: "fatal: crashed\n" }, { exit: 2 }],
    );
    const { model } = setup();
    for (const message of [
      "quota exhausted",
      "cannot ask for permission here: RunCommand (command)",
      "fatal: crashed",
    ]) {
      const { stream } = await model.doStream({
        prompt: [user("hi")],
        providerOptions: { antigravity: { effort: "low" } },
      } as LanguageModelV4CallOptions);
      const parts = await drain(stream);
      expect(parts.find((part) => part.type === "error")).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringContaining(message),
        }),
      });
      expect(parts.at(-1)).toMatchObject({
        type: "finish",
        finishReason: { unified: "error" },
      });
    }
  });

  it("discovers model rows and plan usage, and reports a signed-out CLI as undefined", async () => {
    await script(
      [
        { stderr: "Fetching available models...\n" },
        {
          stdout:
            "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n",
        },
      ],
      [
        {
          stdout: JSON.stringify({
            status: "SUCCESS",
            command: {
              name: "usage",
              data: {
                groups: [
                  {
                    name: "Gemini Models",
                    buckets: [
                      {
                        id: "gemini-5h",
                        window: "5h",
                        remaining_fraction: 0.75,
                        reset_time: "2026-10-04T02:17:49Z",
                      },
                    ],
                  },
                ],
              },
            },
          }),
        },
      ],
      [
        { stderr: "Fetching available models...\n" },
        {
          stderr:
            "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
        },
        { exit: 1 },
      ],
      [
        {
          stderr:
            "Error: authentication required. Run 'antigravity' to log in, then retry.\n",
        },
        {
          stdout: JSON.stringify({
            status: "ERROR",
            error: "authentication failed or timed out",
          }),
        },
        { exit: 1 },
      ],
      [{ stderr: "Error: network unreachable\n" }, { exit: 1 }],
    );
    const { provider } = setup();
    expect(await provider.discoverModels()).toEqual([
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
      { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    ]);
    expect(await provider.readUsage()).toMatchObject({
      groups: [
        { name: "Gemini Models", buckets: [{ remaining_fraction: 0.75 }] },
      ],
    });
    expect(await provider.discoverModels()).toBeUndefined();
    expect(await provider.readUsage()).toBeUndefined();
    await expect(provider.discoverModels()).rejects.toThrow(
      /network unreachable/,
    );
    const calls = await records<CliRun>("calls.jsonl");
    expect(calls.map((entry) => entry.argv)).toEqual([
      ["models"],
      ["-p", "/usage", "--output-format", "json"],
      ["models"],
      ["-p", "/usage", "--output-format", "json"],
      ["models"],
    ]);
    // Closed stdin keeps a signed-out CLI from starting interactive sign-in.
    expect(calls.every((entry) => entry.stdin === "")).toBe(true);
  });

  it("refuses use after disposal", async () => {
    const { provider } = setup();
    await provider.dispose();
    expect(() => provider.languageModel("gemini-3.1-pro")).toThrow(/disposed/);
    await expect(provider.discoverModels()).rejects.toThrow(/disposed/);
  });
});
