// Purpose: Exercises the Antigravity adapter against a real, signed-in CLI; opt in with ANTIGRAVITY_LIVE=<executable>.
import { generateObject, streamText } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import { createAntigravityProvider } from "./provider";

const executable = process.env.ANTIGRAVITY_LIVE;
// Gemini Flash reports no cache reads; Pro and Claude do.
const model = process.env.ANTIGRAVITY_LIVE_MODEL ?? "gemini-3.1-pro";
const effort = process.env.ANTIGRAVITY_LIVE_EFFORT ?? "low";

const provider = executable
  ? createAntigravityProvider({
      executable,
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    })
  : undefined;

afterAll(async () => {
  await provider?.dispose();
});

async function run(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: { tools?: unknown; skipPermissions?: boolean } = {},
) {
  const result = streamText({
    model: provider!.languageModel(model),
    system: "Answer in one short sentence.",
    messages,
    providerOptions: {
      antigravity: {
        cwd: process.cwd(),
        effort,
        tools: options.tools,
        skipPermissions: options.skipPermissions ?? true,
      },
    } as never,
    maxRetries: 0,
    // The adapter reports the resumed conversation in its request body.
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
  const request = (await result.request) as {
    body?: { conversation?: string };
  };
  return {
    events,
    text,
    usage: finish?.type === "finish-step" ? finish.usage : undefined,
    resumed: request.body?.conversation,
  };
}

const secretTool = {
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

describe.skipIf(!executable)("Antigravity live", () => {
  it("lists models and reads plan usage without a turn", async () => {
    const models = await provider!.discoverModels();
    expect(models?.some((row) => row.id.startsWith(`${model}-`))).toBe(true);
    const usage = await provider!.readUsage();
    expect(usage?.groups.length).toBeGreaterThan(0);
  }, 60_000);

  it("chats across turns, resuming the conversation and reusing the prompt cache", async () => {
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
  }, 240_000);

  it("replays edited history into a fresh conversation with full recall", async () => {
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

  it.each([true, false])(
    "runs an OpenChart tool in-process with the exact outcome (skip permissions: %s)",
    async (skipPermissions) => {
      const { events, text } = await run(
        [
          {
            role: "user",
            content:
              "Call the get_secret tool and reply with the secret exactly.",
          },
        ],
        { tools: secretTool, skipPermissions },
      );
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
      // The schema read and MCP call are plumbing, never shown.
      expect(
        events.some(
          (event) =>
            event.type === "tool-call" &&
            ["call_mcp_tool", "view_file"].includes(event.toolName),
        ),
      ).toBe(false);
      expect(text).toMatch(/pineapple-42/);
    },
    240_000,
  );

  it("returns structured output for a JSON schema", async () => {
    const { object } = await generateObject({
      model: provider!.languageModel(model),
      schema: z.object({ city: z.string(), country: z.string() }),
      prompt: "Name the capital of France.",
      providerOptions: {
        antigravity: { cwd: process.cwd(), effort, skipPermissions: true },
      },
      maxRetries: 0,
    });
    expect(object.city).toMatch(/paris/i);
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
      providerOptions: {
        antigravity: { cwd: process.cwd(), effort, skipPermissions: true },
      },
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
});
