// Purpose: Exercises the Codex adapter against a real, logged-in Codex CLI; opt in with CODEX_LIVE=<executable>.
import { spawn } from "node:child_process";
import { streamText } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import { createCodexProvider } from "./provider";
import type { SpawnCodex } from "./rpc";

const executable = process.env.CODEX_LIVE;
const model = process.env.CODEX_LIVE_MODEL ?? "gpt-6-luna";

/** Records every request method the adapter sends while using the real process. */
const sent: string[] = [];
const recordingSpawn: SpawnCodex = (command, args, env) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = ((chunk: string | Uint8Array) => {
    const message = JSON.parse(String(chunk)) as {
      method?: string;
      id?: unknown;
    };
    if (message.method && message.id !== undefined) sent.push(message.method);
    return write(chunk);
  }) as typeof child.stdin.write;
  return child;
};

const provider = executable
  ? createCodexProvider({
      executable,
      spawn: recordingSpawn,
      config: {
        "agents.max_depth": 4,
        "features.multi_agent_v2": true,
        check_for_update_on_startup: false,
      },
    })
  : undefined;

afterAll(async () => {
  await provider?.dispose();
});

async function run(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: { tools?: unknown; abort?: AbortSignal; system?: string } = {},
) {
  const result = streamText({
    model: provider!.languageModel(model),
    system: options.system ?? "Answer in one short sentence.",
    messages,
    providerOptions: {
      "codex-app-server": { cwd: process.cwd(), tools: options.tools },
    } as never,
    abortSignal: options.abort,
    maxRetries: 0,
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of conformProviderStream(result.fullStream))
    events.push(event);
  const text = events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
  return { events, text };
}

describe.skipIf(!executable)("Codex live", () => {
  it("chats across turns, reusing the thread for an appended turn", async () => {
    const first = await run([
      {
        role: "user",
        content: "The code word is amber 7312. Reply exactly: ACK",
      },
    ]);
    expect(first.text).toMatch(/ACK/i);
    expect(sent.filter((method) => method === "thread/start")).toHaveLength(1);

    const second = await run([
      {
        role: "user",
        content: "The code word is amber 7312. Reply exactly: ACK",
      },
      { role: "assistant", content: first.text },
      {
        role: "user",
        content: "What was the code word? Reply with just the code word.",
      },
    ]);
    expect(second.text).toMatch(/7312/);
    expect(sent.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(
      sent.filter((method) => method === "thread/inject_items"),
    ).toHaveLength(0);
  }, 180_000);

  it("injects edited history into a fresh thread with full recall", async () => {
    const before = sent.filter(
      (method) => method === "thread/inject_items",
    ).length;
    const { text } = await run([
      {
        role: "user",
        content: "The secret animal is a narwhal. Reply exactly: NOTED",
      },
      { role: "assistant", content: "NOTED" },
      {
        role: "user",
        content: "Which animal did I name? Reply with just the animal.",
      },
    ]);
    expect(text).toMatch(/narwhal/i);
    expect(
      sent.filter((method) => method === "thread/inject_items"),
    ).toHaveLength(before + 1);
  }, 180_000);

  it("runs an OpenChart tool through dynamic tools and restores the exact outcome", async () => {
    const tools = {
      get_secret: {
        description:
          "Returns the current secret phrase. Call it when asked for the secret.",
        inputSchema: z.object({}),
        execute: async () => ({
          title: "Secret",
          value: "pineapple-42",
          hidden: true,
        }),
        toModelOutput: (output: unknown) => (output as { value: string }).value,
      },
    };
    const { events, text } = await run(
      [
        {
          role: "user",
          content:
            "Call the get_secret tool and reply with the secret exactly.",
        },
      ],
      { tools },
    );
    const call = events.find((event) => event.type === "tool-call");
    const result = events.find((event) => event.type === "tool-result");
    expect(call).toMatchObject({
      toolName: "get_secret",
      providerExecuted: true,
    });
    expect(result).toMatchObject({
      output: { title: "Secret", value: "pineapple-42", hidden: true },
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    expect(text).toMatch(/pineapple-42/);
  }, 180_000);

  it("interrupts a turn on abort", async () => {
    const controller = new AbortController();
    const turns = sent.filter((method) => method === "turn/start").length;
    // Abort shortly after the turn is running so the interrupt has a target.
    const poll = setInterval(() => {
      if (sent.filter((method) => method === "turn/start").length > turns) {
        clearInterval(poll);
        setTimeout(() => controller.abort(), 1_000);
      }
    }, 20);
    await run(
      [
        {
          role: "user",
          content:
            "Write a 3000 word essay on the history of financial charting, section by section.",
        },
      ],
      { abort: controller.signal, system: "Write at length." },
    ).catch(() => undefined);
    clearInterval(poll);
    expect(sent.filter((method) => method === "turn/interrupt")).toHaveLength(
      1,
    );
  }, 120_000);

  it("surfaces a native subagent and its message to root without extra delegates", async () => {
    const { events, text } = await run([
      {
        role: "user",
        content:
          "Use spawn_agent to start exactly one subagent. Its task: first use send_message to send 'Checking arithmetic' to /root, then answer 'What is 2+2?'. Explicitly include the send_message instruction in its task. Wait for it, then reply with its answer only.",
      },
    ]);
    const spawns = events
      .filter((event) => event.type === "tool-call")
      .filter((event) => event.toolName === "spawn_agent");
    expect(spawns, "one subagent must produce exactly one proxy").toHaveLength(
      1,
    );
    const proxyId = spawns[0]!.toolCallId;
    expect(
      events.find(
        (event) =>
          event.type === "tool-call" && event.toolName === "agent_interaction",
      ),
    ).toMatchObject({
      input: { target: "/root" },
      providerMetadata: { openchart: { delegateCallId: proxyId } },
    });
    const steps = events.filter(
      (event) =>
        (event.type === "start-step" || event.type === "finish-step") &&
        event.providerMetadata?.openchart?.delegateCallId === proxyId,
    );
    expect(steps.map((event) => event.type)).toEqual([
      "start-step",
      "finish-step",
    ]);
    const results = events.filter(
      (event) =>
        (event.type === "tool-result" || event.type === "tool-error") &&
        event.toolCallId === proxyId,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool-result" });
    expect(
      results[0]!.providerMetadata?.openchart?.delegateCallId,
    ).toBeUndefined();
    expect(events.indexOf(steps[1]!)).toBeLessThan(events.indexOf(results[0]!));
    expect(text).toMatch(/4/);
  }, 300_000);
});
