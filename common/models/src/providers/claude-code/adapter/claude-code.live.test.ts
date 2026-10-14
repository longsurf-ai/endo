// Purpose: Exercises the Claude adapter against a real, logged-in Claude Code CLI; opt in with CLAUDE_LIVE=<executable>.
import { streamText } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import { createClaudeCodeProvider } from "./provider";

const executable = process.env.CLAUDE_LIVE;
const model = process.env.CLAUDE_LIVE_MODEL ?? "haiku";

const provider = executable
  ? createClaudeCodeProvider({
      executable,
      env: {
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
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
      "claude-code": { cwd: process.cwd(), tools: options.tools },
    } as never,
    abortSignal: options.abort,
    maxRetries: 0,
    // The adapter reports the resumed session in its request body.
    include: { requestBody: true },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of conformProviderStream(result.fullStream))
    events.push(event);
  const text = events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
  const finish = events.find(
    (event) =>
      event.type === "finish-step" && !event.providerMetadata?.openchart,
  );
  const request = (await result.request) as { body?: { resume?: string } };
  return {
    events,
    text,
    usage: finish?.type === "finish-step" ? finish.usage : undefined,
    resumed: request.body?.resume,
  };
}

describe.skipIf(!executable)("Claude Code live", () => {
  it("chats across turns, resuming the session and reusing the prompt cache", async () => {
    const first = await run([
      {
        role: "user",
        content: "The code word is amber 7312. Reply exactly: ACK",
      },
    ]);
    expect(first.text).toMatch(/ACK/i);
    expect(first.resumed).toBeUndefined();

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
    expect(second.resumed).toBeDefined();
    expect(
      second.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    ).toBeGreaterThan(0);
  }, 180_000);

  it("replays edited history into a fresh session with full recall", async () => {
    const { text, resumed } = await run([
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
    expect(resumed).toBeUndefined();
    expect(text).toMatch(/narwhal/i);
  }, 180_000);

  it("runs an OpenChart tool in-process and emits the exact outcome", async () => {
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
    // Claude may look the tool up through ToolSearch first; only ours is checked.
    expect(
      events.find(
        (event) =>
          event.type === "tool-call" && event.toolName === "get_secret",
      ),
    ).toMatchObject({ providerExecuted: true });
    expect(
      events.find(
        (event) =>
          event.type === "tool-result" && event.toolName === "get_secret",
      ),
    ).toMatchObject({
      output: { title: "Secret", value: "pineapple-42", hidden: true },
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    expect(text).toMatch(/pineapple-42/);
  }, 180_000);

  it("interrupts a turn on abort and closes the stream as interrupted", async () => {
    // streamText surfaces the caller's abort itself; the adapter's own closing
    // behavior is visible on the raw model stream.
    const controller = new AbortController();
    const { stream } = await provider!.languageModel(model).doStream({
      prompt: [
        { role: "system", content: "Write at length." },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Write a 3000 word essay on the history of financial charting, section by section.",
            },
          ],
        },
      ],
      abortSignal: controller.signal,
      providerOptions: { "claude-code": { cwd: process.cwd() } },
    });
    const reader = stream.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (value.type === "text-delta" && !controller.signal.aborted)
        controller.abort();
    }
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "interrupted" },
    });
  }, 120_000);

  it("surfaces a native subagent as a nested delegate", async () => {
    const { events, text } = await run([
      {
        role: "user",
        content:
          "Use the Agent tool to start exactly one general-purpose subagent whose only job is to answer 'What is 2+2?'. Wait for it, then reply with just its answer.",
      },
    ]);
    const task = events.find(
      (event) =>
        event.type === "tool-call" && /^(Task|Agent)$/.test(event.toolName),
    );
    expect(task, "the model did not spawn a subagent").toBeDefined();
    const steps = events.filter(
      (event) => event.type === "start-step" || event.type === "finish-step",
    );
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(text).toMatch(/4/);
  }, 300_000);
});
