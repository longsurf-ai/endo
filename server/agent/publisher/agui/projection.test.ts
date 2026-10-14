// Purpose: Verifies native AG-UI history and committed-event replay with the community reducer.

import { AbstractAgent } from "@ag-ui/client";
import {
  EventSchemas,
  EventType,
  MessageSchema,
  type AGUIEvent,
  type Message as AgUiMessage,
} from "@ag-ui/core";
import { WithParts } from "@openchart/server/agent/contracts/message";
import { Part } from "@openchart/server/agent/contracts/part";
import { toModelMessages } from "@openchart/server/agent/session/message/to-model-messages";
import { Effect, Schema } from "effect";
import { from } from "rxjs";
import { describe, expect, test } from "vitest";
import {
  activePartEvents,
  partEvents,
  projectMessage,
  projectPart,
  projectTranscript,
  userMessageEvents,
} from "./projection";
import { messageInfoEvent, projectMessageInfo } from "./state";

function message(
  role: "user" | "assistant",
  parts: object[],
  extra = {},
): WithParts {
  const id = `msg_${role}`;
  return Schema.decodeUnknownSync(WithParts)({
    info: {
      id,
      sessionID: "ses_test",
      role,
      time: { created: 1 },
      agent: "analyst",
      ...(role === "user"
        ? { model: { providerID: "test", modelID: "test" } }
        : {
            triggeringUserMessageID: "msg_user",
            modelID: "test",
            providerID: "test",
            path: { cwd: "/test", root: "/test" },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          }),
      ...extra,
    },
    parts: parts.map((part, index) => ({
      id: `prt_${index}`,
      messageID: id,
      ...part,
    })),
  });
}

function part(input: object): Part {
  return Schema.decodeUnknownSync(Part)({
    id: "prt_0",
    messageID: "msg_assistant",
    ...input,
  });
}

test("history and live headers retain each reply's execution workspace", () => {
  const original = message("assistant", [], {
    id: "msg_original",
    path: { cwd: "/original", root: "/original" },
  });
  const later = message("assistant", [], {
    id: "msg_later",
    path: { cwd: "/later", root: "/later" },
  });
  const headers = projectMessageInfo([original, later]);
  expect(headers.msg_original).toMatchObject({ workspaceRoot: "/original" });
  expect(headers.msg_later).toMatchObject({ workspaceRoot: "/later" });
  for (const { info } of [original, later]) {
    expect(messageInfoEvent(info)).toEqual([
      {
        type: EventType.STATE_DELTA,
        delta: [
          {
            op: "add",
            path: `/messageInfo/${info.id}`,
            value: headers[info.id],
          },
        ],
      },
    ]);
  }
});

function tool(state: object, extra = {}) {
  return {
    type: "tool",
    childSessionIds: [],
    callID: "call_echo",
    tool: "Echo",
    state,
    ...extra,
  };
}

function completed(extra = {}) {
  return {
    status: "completed",
    input: { text: "hello" },
    output: { type: "text", value: "echo hello" },
    title: "Echo",
    metadata: {},
    time: { start: 1, end: 2 },
    ...extra,
  };
}

async function replay(
  events: AGUIEvent[],
  initialMessages: AgUiMessage[] = [],
) {
  const stream: AGUIEvent[] = [
    { type: EventType.RUN_STARTED, threadId: "ses_test", runId: "run_test" },
    ...events,
    { type: EventType.RUN_FINISHED, threadId: "ses_test", runId: "run_test" },
  ];
  for (const event of stream)
    expect(EventSchemas.safeParse(event).success).toBe(true);
  const agent = new (class extends AbstractAgent {
    /** Returns this test's native event stream. @example agent.run(); */
    run() {
      return from(stream);
    }
  })({ threadId: "ses_test", initialMessages });
  await agent.runAgent({ runId: "run_test" });
  for (const item of agent.messages)
    expect(MessageSchema.safeParse(item).success).toBe(true);
  return agent.messages;
}

describe("AG-UI projection", () => {
  test("hides plugin context while retaining ordinary user text and context", () => {
    const input = message("user", [
      { type: "text", text: "Question" },
      {
        type: "context",
        context: { kind: "document", title: "Notes", text: "Document" },
      },
      {
        type: "context",
        context: {
          kind: "plugin",
          pluginId: "research",
          hook: "run.before",
          content: "Plugin context",
        },
      },
    ]);
    expect(projectMessage(input)).toMatchObject([
      {
        role: "user",
        content: "Question\nNotes",
        metadata: { parts: input.parts },
      },
    ]);
  });

  test("preserves interleaved Part IDs, tool pairing, JSON output, and child-session links", () => {
    const input = message("assistant", [
      { type: "reasoning", text: "Thinking", time: { start: 1, end: 2 } },
      { type: "text", text: "Before" },
      tool(completed({ output: { type: "json", value: { count: 3 } } }), {
        childSessionIds: ["ses_child"],
      }),
      { type: "text", text: "After" },
      { type: "step-start" },
    ]);
    const result = projectMessage(input);
    expect(result.map((item) => [item.id, item.role])).toEqual([
      ["prt_0", "reasoning"],
      ["prt_1", "assistant"],
      ["prt_2", "assistant"],
      ["prt_2:result", "tool"],
      ["prt_2:activity", "activity"],
      ["prt_3", "assistant"],
    ]);
    expect(result[2]).toMatchObject({
      toolCalls: [
        {
          id: "call_echo",
          function: { name: "Echo", arguments: '{"text":"hello"}' },
        },
      ],
    });
    expect(result[4]).toMatchObject({
      content: { toolCallId: "call_echo", childSessionId: "ses_child" },
    });
    expect(result[3]).toMatchObject({
      content: '{"count":3}',
      toolCallId: "call_echo",
    });
    for (const item of result)
      expect(MessageSchema.safeParse(item).success).toBe(true);
  });

  test("keeps visible user text, typed media, source IDs, and structured contexts without model-only text", () => {
    const input = message("user", [
      { type: "text", text: "question" },
      { type: "text", text: "synthetic context", synthetic: true },
      {
        type: "context",
        context: {
          kind: "quote",
          text: "Selected",
        },
      },
      {
        type: "file",
        mime: "image/png",
        filename: "chart.png",
        url: "https://example.test/chart.png",
      },
      {
        type: "context",
        context: {
          kind: "document",
          title: "Report",
          text: "long model context",
        },
      },
    ]);
    const result = projectMessage(input);
    expect(result).toHaveLength(1);
    // Quotes and attachments render from metadata.parts, never from bubble text.
    expect(result[0]).toMatchObject({
      id: "msg_user",
      role: "user",
      content: "question\nReport",
    });
    expect(result[0]?.metadata?.parts).toEqual(
      input.parts.filter((_, index) => index !== 1),
    );
    expect(MessageSchema.safeParse(result[0]).success).toBe(true);
    const detached = result[0]?.metadata?.parts as Part[];
    detached[0]!.id = "mutated";
    expect(input.parts[0]?.id).toBe("prt_0");
  });

  test("appends a user message through the community reducer exactly as history projects it", async () => {
    const input = message("user", [
      { type: "context", context: { kind: "quote", text: "Selected" } },
      { type: "text", text: "question" },
      {
        type: "file",
        mime: "image/png",
        filename: "chart.png",
        url: "https://example.test/chart.png",
      },
      { type: "text", text: "hidden", synthetic: true },
    ]);
    const events = userMessageEvents(input);
    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(await replay(events)).toEqual(projectMessage(input));

    // An attachment-only input carries no text delta.
    const silent = message("user", [
      { type: "file", mime: "image/png", url: "https://example.test/a.png" },
    ]);
    expect(userMessageEvents(silent).map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(await replay(userMessageEvents(silent))).toEqual(
      projectMessage(silent),
    );
  });

  test("projects terminal tool errors into the native field consumed by assistant-ui", () => {
    const input = message("assistant", [
      tool({
        status: "error",
        input: null,
        error: "Permission denied",
        time: { start: 1, end: 2 },
      }),
    ]);
    expect(projectMessage(input)[1]).toMatchObject({
      role: "tool",
      error: "Permission denied",
      content: "Permission denied",
    });
  });
});

describe("native execution activity", () => {
  test.each([0, 499, 500, 501])(
    "keeps short results intact and marks a truncated %i-character result",
    (length) => {
      const value = "€".repeat(length);
      const input = message("assistant", [
        tool(completed({ output: { type: "text", value } })),
      ]);
      expect(
        projectMessage(input).find((item) => item.role === "tool")?.content,
      ).toBe(length <= 500 ? value : `${"€".repeat(500)}\n… [truncated]`);
    },
  );

  test("caps live and cold results while preserving display metadata, arguments, attachments and model history", async () => {
    const value = { body: "large-result-".repeat(100_000) };
    const trace = { resourceSpans: [] };
    const computerUse = {
      title: "Computer use",
      screenshot: { mime: "image/png", url: "data:image/png;base64,YQ==" },
    };
    const metadata = {
      trace,
      computerUse,
      "codex-app-server": {
        rawItem: { body: "private-provider-".repeat(100_000) },
      },
    };
    const attachments = [
      {
        id: "prt_attachment",
        messageID: "msg_assistant",
        type: "file",
        mime: "text/plain",
        url: "https://example.com/report.txt",
      },
    ];
    const input = message("assistant", [
      tool(
        completed({
          input: { query: "Keep the original arguments" },
          output: { type: "json", value },
          metadata,
          attachments,
        }),
        { tool: "workflow" },
      ),
    ]);
    const original = structuredClone(input);
    const finished = input.parts[0]!;
    const events = partEvents(input.info, undefined, finished)!;
    const cold = projectMessage(input);
    expect(await replay(events)).toEqual(cold);
    expect(cold.find((item) => item.role === "tool")?.content).toBe(
      `${JSON.stringify(value).slice(0, 500)}\n… [truncated]`,
    );
    expect(cold[0]).toMatchObject({
      toolCalls: [
        {
          function: {
            arguments: '{"query":"Keep the original arguments"}',
          },
        },
      ],
    });
    expect(cold.find((item) => item.role === "activity")).toMatchObject({
      content: { details: { trace, computerUse }, attachments },
    });
    expect(JSON.stringify({ events, cold })).not.toContain("private-provider");
    expect(JSON.stringify({ events, cold }).length).toBeLessThan(5_000);
    expect(input).toEqual(original);
    const model = await Effect.runPromise(
      toModelMessages([input], {
        providerID: "test",
        id: "test",
      }),
    );
    expect(JSON.stringify(model)).toContain(value.body);
    const changed = part(
      tool(
        completed({
          input: { query: "Keep the original arguments" },
          output: { type: "json", value },
          metadata: { ...metadata, "codex-app-server": { rawItem: "updated" } },
          attachments,
        }),
        { tool: "workflow" },
      ),
    );
    expect(partEvents(input.info, finished, changed)).toEqual([]);
  });

  test("preserves the entire tool error, including details beyond the preview limit", async () => {
    const error = `Failed: ${"details ".repeat(100)}`;
    const input = message("assistant", [
      tool({
        status: "error",
        input: {},
        error,
        time: { start: 1, end: 2 },
      }),
    ]);
    const cold = projectMessage(input);
    expect(cold.find((item) => item.role === "tool")).toMatchObject({
      content: error,
      error,
    });
    expect(
      await replay(partEvents(input.info, undefined, input.parts[0]!)!),
    ).toEqual(cold);
  });

  test.each([false, true])(
    "computer frames converge across live updates and cold history (display only: %s)",
    async (displayOnly) => {
      const info = message("assistant", []).info;
      const events: AGUIEvent[] = [];
      const captures: Part[] = [];
      for (const id of ["first", "second"]) {
        const before = part({
          ...tool({ status: "running", input: {}, time: { start: 1 } }),
          id: `prt_${id}`,
          callID: `capture_${id}`,
        });
        const image = {
          mime: "image/png",
          url: `https://example.com/${id}.png`,
        };
        const after = part({
          ...before,
          state: completed({
            input: {},
            output: { type: "text", value: `Captured ${id}` },
            attachments: displayOnly
              ? []
              : [
                  {
                    ...image,
                    id: `prt_${id}_image`,
                    messageID: info.id,
                    type: "file",
                  },
                ],
            metadata: {
              computerUse: {
                title: "Computer use",
                ...(displayOnly ? { screenshot: image } : {}),
              },
            },
          }),
        });
        events.push(
          ...partEvents(info, undefined, before)!,
          ...partEvents(info, before, after)!,
        );
        captures.push(after);
      }
      const live = await replay(events);
      const cold = projectTranscript([{ info, parts: captures }]);
      expect(live).toEqual(cold);
      expect(
        events.some((event) => event.type === EventType.MESSAGES_SNAPSHOT),
      ).toBe(false);
      expect(
        events.filter((event) => event.type === EventType.ACTIVITY_DELTA),
      ).toHaveLength(2);
      expect(
        live.filter((message) => message.role === "activity"),
      ).toHaveLength(2);
      // Bytes belong to Activity only, never the plain-text tool result as well.
      for (const id of ["first", "second"])
        expect(
          JSON.stringify(live).split(`https://example.com/${id}.png`),
        ).toHaveLength(2);
    },
  );

  test.each(["Search timed out", ""])(
    "streams progress and failure %j without transcript snapshots",
    async (error) => {
      const info = message("assistant", []).info;
      let previous = part(tool({ status: "pending", input: {} }));
      const initial = projectPart(info, previous);
      const events = activePartEvents([{ info, parts: [previous] }]);
      let middle = initial;
      let middleEvents = events.length;
      for (let pagesRead = 0; pagesRead < 30; pagesRead++) {
        const next = part(
          tool(
            {
              status: "running",
              input: {},
              title: `Reading page ${pagesRead}`,
              metadata: { pagesRead },
              time: { start: 1 },
            },
            { childSessionIds: ["ses_child"] },
          ),
        );
        const updates = partEvents(info, previous, next)!;
        expect(updates).toBeDefined();
        if (pagesRead > 0)
          expect(updates.map((event) => event.type)).toEqual([
            EventType.ACTIVITY_DELTA,
          ]);
        events.push(...updates);
        previous = next;
        if (pagesRead === 12) {
          middle = projectPart(info, next);
          middleEvents = events.length;
        }
      }
      const failed = part(
        tool(
          {
            status: "error",
            input: {},
            error,
            metadata: { pagesRead: 29 },
            time: { start: 1, end: 2 },
          },
          { childSessionIds: ["ses_child"] },
        ),
      );
      events.push(...partEvents(info, previous, failed)!);
      expect(
        events.some((event) => event.type === EventType.MESSAGES_SNAPSHOT),
      ).toBe(false);
      expect(await replay(events, initial)).toEqual(projectPart(info, failed));
      expect(await replay(events.slice(middleEvents), middle)).toEqual(
        projectPart(info, failed),
      );
      expect(
        (await replay(events, initial)).find(
          (message) => message.role === "tool",
        ),
      ).toMatchObject({ error });
      expect(partEvents(info, failed, { ...failed })).toEqual([]);
    },
  );

  test("does not replay a completed result for provider bookkeeping or pruning", () => {
    const info = message("assistant", []).info;
    const before = part(tool(completed()));
    const after = part(
      tool(completed({ time: { start: 1, end: 2, compacted: 4 } }), {
        providerMetadata: { provider: { changed: true } },
      }),
    );
    expect(partEvents(info, before, after)).toEqual([]);
  });

  test("updates an individual file activity with the official reducer", async () => {
    const info = message("assistant", []).info;
    const before = part({
      type: "file",
      mime: "image/png",
      url: "https://example.com/one.png",
    });
    const after = part({ ...before, url: "https://example.com/two.png" });
    const events = [
      ...partEvents(info, undefined, before)!,
      ...partEvents(info, before, after)!,
    ];
    expect(events.map((event) => event.type)).toEqual([
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_DELTA,
    ]);
    expect(await replay(events)).toEqual(projectPart(info, after));
  });
});

describe("committed AG-UI events", () => {
  test.each(["text", "reasoning"] as const)(
    "finishes %s without replacing final trimmed content",
    async (type) => {
      const info = message("assistant", []).info;
      const before = part({ type, text: "Complete  ", time: { start: 1 } });
      const after = part({
        type,
        text: "Complete",
        time: { start: 1, end: 2 },
      });
      expect(partEvents(info, before, after)).toBeDefined();
      const snapshot = projectPart(info, after);
      expect(
        await replay([
          ...partEvents(info, undefined, before)!,
          ...partEvents(info, before, after)!,
        ]),
      ).toEqual(snapshot);
    },
  );

  test.each(["text", "reasoning"] as const)(
    "community reducer reproduces %s snapshots without duplicate starts",
    async (type) => {
      const info = message("assistant", []).info;
      const start = part({ type, text: "", time: { start: 1 } });
      const delta = part({ type, text: "Hello", time: { start: 1 } });
      const end = part({
        type,
        text: "Hello world",
        time: { start: 1, end: 2 },
      });
      const events = [
        ...partEvents(info, undefined, start)!,
        ...partEvents(info, start, delta)!,
        ...partEvents(info, delta, end)!,
      ];
      expect(await replay(events)).toEqual(projectPart(info, end));
      expect(partEvents(info, end, { ...end })).toEqual([]);
      expect(
        partEvents(
          info,
          delta,
          part({ type, text: "replacement", time: { start: 1 } }),
        ),
      ).toBeUndefined();
      expect(
        partEvents(
          info,
          end,
          part({ type, text: "Hello world!", time: { start: 1, end: 2 } }),
        ),
      ).toBeUndefined();
    },
  );

  test("community reducer reconstructs a tool and its result from committed argument and terminal transitions", async () => {
    const info = message("assistant", []).info;
    const pending = part(tool({ status: "pending", input: {} }));
    const running = part(
      tool({ status: "running", input: { text: "hello" }, time: { start: 1 } }),
    );
    const end = part(tool(completed()));
    const events = [
      ...partEvents(info, undefined, pending)!,
      ...partEvents(info, pending, running)!,
      ...partEvents(info, running, end)!,
    ];
    expect(events.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_DELTA,
      EventType.TOOL_CALL_RESULT,
      EventType.ACTIVITY_DELTA,
    ]);
    const messages = await replay(events);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      id: "prt_0",
      toolCalls: [{ function: { arguments: '{"text":"hello"}' } }],
    });
    expect(messages[1]).toMatchObject({
      id: "prt_0:result",
      toolCallId: "call_echo",
      content: "echo hello",
    });
    expect(messages).toEqual(projectPart(info, end));
  });

  test("cold-start reopening preserves partial text and tool arguments without duplication", async () => {
    const history = message("assistant", [
      { type: "text", text: "Already ", time: { start: 1 } },
      tool({ status: "pending", input: {} }),
      { type: "reasoning", text: "Finished", time: { start: 1, end: 2 } },
    ]);
    const text = part({
      type: "text",
      text: "Already streaming",
      time: { start: 1, end: 3 },
    });
    const pending = history.parts[1]!;
    const running = part({
      ...tool({
        status: "running",
        input: { text: "hello" },
        time: { start: 2 },
      }),
      id: pending.id,
    });
    const events = activePartEvents([history]);
    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TOOL_CALL_START,
    ]);
    const messages = await replay([
      { type: EventType.MESSAGES_SNAPSHOT, messages: projectMessage(history) },
      ...events,
      ...partEvents(history.info, history.parts[0], text)!,
      ...partEvents(history.info, pending, running)!,
    ]);
    expect(messages.map((item) => item.id)).toEqual([
      "prt_0",
      "prt_1",
      "prt_1:activity",
      "prt_2",
    ]);
    expect(messages[0]).toMatchObject({ content: "Already streaming" });
    expect(messages[1]).toMatchObject({
      toolCalls: [{ function: { arguments: '{"text":"hello"}' } }],
    });
    expect(
      activePartEvents([
        message("assistant", history.parts, {
          time: { created: 1, completed: 3 },
        }),
      ]),
    ).toEqual([]);
  });
});
