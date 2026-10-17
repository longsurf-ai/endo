// Purpose: Exercises the Grok adapter against a real, signed-in CLI; opt in with GROK_LIVE=<executable>.
import os from "node:os";
import path from "node:path";
import { generateObject, streamText } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import type { GrokProviderOptions } from "./language-model";
import { createGrokProvider } from "./provider";

const executable = process.env.GROK_LIVE;
const model = process.env.GROK_LIVE_MODEL ?? "grok-4.7";
const effort = process.env.GROK_LIVE_EFFORT ?? "low";

const provider = executable
  ? createGrokProvider({
      executable,
      env: { GROK_DISABLE_AUTOUPDATER: "1" },
    })
  : undefined;

afterAll(async () => {
  await provider?.dispose();
});

async function run(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: Partial<GrokProviderOptions> = {},
) {
  const result = streamText({
    model: provider!.languageModel(model),
    system: "Answer in one short sentence.",
    messages,
    providerOptions: {
      grok: {
        cwd: process.cwd(),
        effort,
        permissionMode: "always-approve",
        ...options,
      },
    } as never,
    maxRetries: 0,
    // The adapter reports the resumed session in its request body.
    include: { requestBody: true },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of conformProviderStream(result.fullStream))
    events.push(event);
  const text = events
    .filter(
      (event) =>
        event.type === "text-delta" && !event.providerMetadata?.openchart,
    )
    .map((event) => (event as { text: string }).text)
    .join("");
  const finish = events.find(
    (event) =>
      event.type === "finish-step" && !event.providerMetadata?.openchart,
  );
  const request = (await result.request) as { body?: { session?: string } };
  return {
    events,
    text,
    usage: finish?.type === "finish-step" ? finish.usage : undefined,
    resumed: request.body?.session,
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

describe.skipIf(!executable)("Grok live", () => {
  it("lists models and reads plan usage without a session", async () => {
    const models = await provider!.discoverModels();
    expect(models?.some((row) => row.modelId === model)).toBe(true);
    const usage = await provider!.readUsage();
    expect(usage?.subscription.authenticated).toBe(true);
    expect(usage?.billing.config.creditUsagePercent).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("chats across turns, resuming the session and reusing the prompt cache", async () => {
    const opening = {
      role: "user" as const,
      content:
        "Remember the number 7312 for my next question. Reply with just OK.",
    };
    const first = await run([opening]);
    expect(first.text).toMatch(/OK/i);
    expect(first.resumed).toBeUndefined();

    const second = await run([
      opening,
      { role: "assistant", content: first.text },
      {
        role: "user",
        content:
          "Which number did I ask you to remember? Reply with just the number.",
      },
    ]);
    expect(second.text).toMatch(/7312/);
    expect(second.resumed).toBeDefined();
    console.info("Grok prompt cache", {
      first: first.usage?.inputTokenDetails,
      second: second.usage?.inputTokenDetails,
    });
    expect(
      second.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    ).toBeGreaterThan(0);
  }, 240_000);

  it("keeps xAI's prompt cache warm across resumed turns, unlike a fresh replay", async () => {
    type Message = { role: "user" | "assistant"; content: string };
    const cached = (usage: Awaited<ReturnType<typeof run>>["usage"]) =>
      (usage?.inputTokenDetails?.cacheReadTokens ?? 0) /
      Math.max(1, usage?.inputTokens ?? 0);
    const history: Message[] = [];
    const turns = [];
    for (const content of [
      "Remember the city Lisbon for later. Reply with just OK.",
      "Also remember the color teal. Reply with just OK.",
      "Name the city and the color I gave you, separated by a comma.",
    ]) {
      history.push({ role: "user", content });
      const turn = await run([...history]);
      history.push({ role: "assistant", content: turn.text });
      turns.push(turn);
    }
    expect(turns[2]!.text).toMatch(/lisbon.*teal/i);
    // Editing the first message misses the remembered session: the same
    // conversation replays into a fresh session and a new cache prefix.
    const fresh = await run([
      { ...history[0]!, content: `${history[0]!.content} ` },
      ...history.slice(1, -1),
    ]);
    console.info(
      "Grok prompt cache by turn",
      [...turns, fresh].map((turn, index) => ({
        turn: index < turns.length ? index + 1 : "fresh replay",
        resumed: turn.resumed !== undefined,
        input: turn.usage?.inputTokens,
        cacheRead: turn.usage?.inputTokenDetails?.cacheReadTokens,
        cached: `${Math.round(cached(turn.usage) * 100)}%`,
      })),
    );
    expect(turns.map((turn) => turn.resumed !== undefined)).toEqual([
      false,
      true,
      true,
    ]);
    expect(fresh.resumed).toBeUndefined();
    for (const turn of turns.slice(1))
      expect(cached(turn.usage)).toBeGreaterThan(0.8);
    expect(cached(fresh.usage)).toBeLessThan(cached(turns[2]!.usage));
  }, 360_000);

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

  it.each(["always-approve", "default"] as const)(
    "runs an OpenChart tool in-process with the exact outcome (%s)",
    async (permissionMode) => {
      const { events, text } = await run(
        [
          {
            role: "user",
            content:
              "Call the get_secret tool and reply with the secret exactly.",
          },
        ],
        { tools: secretTool, permissionMode },
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
      // Tool discovery and the MCP call are plumbing, never shown.
      expect(
        events.some(
          (event) =>
            event.type === "tool-call" &&
            ["search_tool", "use_tool"].includes(event.toolName),
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
        grok: { cwd: process.cwd(), effort, permissionMode: "always-approve" },
      },
      maxRetries: 0,
    });
    expect(object.city).toMatch(/paris/i);
  }, 180_000);

  it("searches X natively as a provider-executed tool", async () => {
    const { events, text } = await run([
      {
        role: "user",
        content:
          "Use your X search to find the newest post from @elonmusk. Reply with only its x.com URL.",
      },
    ]);
    const search = events.find(
      (event) => event.type === "tool-call" && event.toolName === "x_search",
    );
    expect(search).toMatchObject({ providerExecuted: true });
    expect(
      events.find(
        (event) =>
          event.type === "tool-result" && event.toolName === "x_search",
      ),
    ).toBeDefined();
    expect(text).toMatch(/x\.com\/elonmusk\/status\/\d+/);
  }, 240_000);

  it("streams a foreground subagent as a delegate sealed before its proxy result", async () => {
    const { events, text } = await run([
      {
        role: "user",
        content:
          "Use spawn_subagent exactly once (not in the background) with description 'echo probe' and prompt 'Run the shell command `echo delegate-7` and reply with its output.' Then reply with the subagent's answer.",
      },
    ]);
    const open = events.find(
      (event) =>
        event.type === "tool-call" &&
        event.providerMetadata?.openchart?.openDelegate !== undefined,
    );
    expect(open).toMatchObject({
      toolName: "spawn_subagent",
      providerMetadata: {
        openchart: { openDelegate: { description: "echo probe" } },
      },
    });
    const id = (open as { toolCallId: string }).toolCallId;
    const owned = (event: ModelStreamEvent) =>
      event.providerMetadata?.openchart?.delegateCallId === id;
    const start = events.findIndex(
      (event) => event.type === "start-step" && owned(event),
    );
    const finish = events.findIndex(
      (event) => event.type === "finish-step" && owned(event),
    );
    const proxy = events.findIndex(
      (event) => event.type === "tool-result" && event.toolCallId === id,
    );
    const childTool = events.findIndex(
      (event) => event.type === "tool-call" && owned(event),
    );
    expect(start).toBeGreaterThan(events.indexOf(open!));
    expect(childTool).toBeGreaterThan(start);
    expect(finish).toBeGreaterThan(childTool);
    expect(proxy).toBeGreaterThan(finish);
    expect(text).toMatch(/delegate-7/);
  }, 300_000);

  it("asks the host before a native action it cannot auto-approve", async () => {
    const requests: unknown[] = [];
    const { text } = await run(
      [
        {
          role: "user",
          content: `Run exactly this shell command and report its exit code: rm -f ${path.join(os.tmpdir(), `openchart-grok-probe-${process.pid}`)}`,
        },
      ],
      {
        permissionMode: "default",
        approve: async (request) => {
          requests.push(request);
          return true;
        },
      },
    );
    expect(requests[0]).toMatchObject({
      kind: "execute",
      input: { command: expect.stringContaining("rm -f") },
    });
    expect(text).toMatch(/0/);
  }, 240_000);

  it("answers ask_user_question through the host", async () => {
    const asked: unknown[] = [];
    const { text } = await run(
      [
        {
          role: "user",
          content:
            "Use ask_user_question to ask which color I prefer, with options Red and Blue. Then reply with only my answer.",
        },
      ],
      {
        answer: async (request) => {
          asked.push(request);
          return { [request.questions[0]!.question]: "Blue" };
        },
      },
    );
    expect(asked).toHaveLength(1);
    expect(text).toMatch(/blue/i);
  }, 240_000);

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
        grok: { cwd: process.cwd(), effort, permissionMode: "always-approve" },
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
