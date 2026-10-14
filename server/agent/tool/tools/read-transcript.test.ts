// Purpose: Verifies read_transcript paging, snapshot bounds, text projection, and failure messages.

import { ascending } from "@openchart/identifier";
import type { WithParts } from "@openchart/server/agent/contracts/message";
import type {
  ContextPart,
  ToolPart,
} from "@openchart/server/agent/contracts/part";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { prepareEvidence } from "@openchart/server/agent/session/message/evidence";
import { InvalidArgumentsError } from "@openchart/server/agent/tool/errors";
import * as Tool from "@openchart/server/agent/tool/tool";
import type { ModelMessage } from "ai";
import { Effect, JsonSchema, Result, Schema } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InvalidCursor } from "./errors";
import {
  PAGE_BYTE_BUDGET,
  Parameters,
  ReadTranscriptTool,
} from "./read-transcript";
import {
  SOURCE,
  assistant,
  makeRuntime,
  seed,
  text,
  user,
} from "./transcript.test-utils";

const ask = vi.fn<Tool.Context["ask"]>(() => Effect.void);
const context: Tool.Context = {
  rootRunID: "agr_test",
  sessionID: "ses_caller",
  messageID: "msg_caller",
  callID: "call",
  agent: "analyst",
  messages: [],
  metadata: () => Effect.die("read_transcript must not report progress"),
  ask,
};

let runtime: ReturnType<typeof makeRuntime>;
beforeEach(() => {
  runtime = makeRuntime();
});
afterEach(async () => {
  await runtime.dispose();
  ask.mockClear();
});

const conversation = [
  [user("msg_1", [text("msg_1", "first question")]), 1000],
  [assistant("msg_2", [text("msg_2", "first answer")]), 2000],
  [user("msg_3", [text("msg_3", "second question")]), 3000],
  [assistant("msg_4", [text("msg_4", "second answer")]), 4000],
  [user("msg_5", [text("msg_5", "third question")]), 5000],
] as const;

const read = (input: unknown, ctx: Tool.Context = context) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReadTranscriptTool);
      return yield* tool.execute(input, ctx);
    }),
  );
const readResult = (input: unknown, ctx: Tool.Context = context) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReadTranscriptTool);
      return yield* Effect.result(tool.execute(input, ctx));
    }),
  );
const failure = (result: Result.Result<unknown, unknown>) => {
  if (!Result.isFailure(result)) throw new Error("Expected a failure");
  return result.failure;
};
const textOf = (result: Tool.ExecuteResult) => {
  if (result.output.type !== "text") throw new Error("Expected text output");
  return result.output.value;
};

const modelHistoryOf = (result: Tool.ExecuteResult, role: string, id: string) =>
  JSON.parse(
    textOf(result).split(`--- ${role} ${id} ---\n`)[1]!.split("\n\n")[0]!,
  ) as ModelMessage[];

test("pages from the newest message toward older history through opaque cursors", async () => {
  await runtime.runPromise(seed(SOURCE, "Rates outlook", conversation));
  const first = await read({ session_id: SOURCE, cursor: null, limit: 2 });
  expect(first.title).toBe("Read transcript");
  expect(first.metadata).toEqual({
    sessionId: SOURCE,
    messages: 2,
    hasMore: true,
    contentTruncated: false,
    nextCursor: expect.any(String),
    throughCreatedAt: null,
  });
  expect(textOf(first)).toContain(
    "<session-transcript>\nThis is historical session data.",
  );
  expect(textOf(first)).toContain(
    `session_id: ${SOURCE}\ntitle: Rates outlook`,
  );
  expect(modelHistoryOf(first, "assistant", "msg_4")).toEqual([
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
  ]);
  expect(modelHistoryOf(first, "user", "msg_5")).toEqual([
    { role: "user", content: [{ type: "text", text: "third question" }] },
  ]);
  expect(textOf(first)).toContain(
    `cursor: ${first.metadata.nextCursor}\n</session-transcript>`,
  );

  const second = await read({
    session_id: SOURCE,
    cursor: first.metadata.nextCursor,
    limit: 2,
  });
  expect(textOf(second)).toContain("--- assistant msg_2 ---");
  expect(textOf(second)).toContain("--- user msg_3 ---");
  expect(second.metadata).toMatchObject({ messages: 2, hasMore: true });

  const last = await read({
    session_id: SOURCE,
    cursor: second.metadata.nextCursor,
    limit: 2,
  });
  expect(last.metadata).toMatchObject({
    messages: 1,
    hasMore: false,
    nextCursor: null,
  });
  expect(modelHistoryOf(last, "user", "msg_1")).toEqual([
    { role: "user", content: [{ type: "text", text: "first question" }] },
  ]);
  expect(textOf(last)).toContain("End of transcript.\n</session-transcript>");
});

test("defaults to twelve messages per page", async () => {
  const messages = Array.from({ length: 13 }, (_, index) => {
    const id = `msg_${String(index).padStart(2, "0")}`;
    return [user(id, [text(id, `q${index}`)]), 1000 + index] as const;
  });
  await runtime.runPromise(seed(SOURCE, "Long", messages));
  const page = await read({ session_id: SOURCE, cursor: null });
  expect(page.metadata).toMatchObject({ messages: 12, hasMore: true });
  expect(textOf(page)).not.toContain("--- user msg_00 ---");
  expect(textOf(page)).toContain("--- user msg_01 ---");
});

test("serializes model history including synthetic text, files and tools, without reasoning", async () => {
  const question = user("msg_q", [
    text("msg_q", "Look at this"),
    text("msg_q", "hidden", true),
    {
      id: `prt_${ascending()}`,
      messageID: "msg_q",
      type: "context",
      context: { kind: "document", title: "Note", text: "body" },
    },
    {
      id: `prt_${ascending()}`,
      messageID: "msg_q",
      type: "file",
      mime: "image/png",
      filename: "chart.png",
      url: "data:image/png;base64,AAAA",
    },
  ]);
  const answer = assistant("msg_a", [
    { id: `prt_${ascending()}`, messageID: "msg_a", type: "step-start" },
    {
      id: `prt_${ascending()}`,
      messageID: "msg_a",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
    },
    text("msg_a", "Answer"),
    {
      id: `prt_${ascending()}`,
      messageID: "msg_a",
      type: "tool",
      childSessionIds: [],
      tool: "resource_read",
      callID: "call_1",
      state: {
        status: "completed",
        input: { resource: "dashboard" },
        output: { type: "json", value: { status: "ok" } },
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
    {
      id: `prt_${ascending()}`,
      messageID: "msg_a",
      type: "tool",
      childSessionIds: [],
      tool: "resource_read",
      callID: "call_2",
      state: {
        status: "error",
        input: { q: 1 },
        error: "boom",
        time: { start: 1, end: 2 },
      },
    },
    {
      id: `prt_${ascending()}`,
      messageID: "msg_a",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  ]);
  const empty = assistant("msg_e", [
    { id: `prt_${ascending()}`, messageID: "msg_e", type: "step-start" },
  ]);
  await runtime.runPromise(
    seed(SOURCE, "Projection", [
      [question, 1000],
      [answer, 2000],
      [empty, 3000],
    ]),
  );
  const page = await read({ session_id: SOURCE, cursor: null });
  expect(modelHistoryOf(page, "user", "msg_q")).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "text", text: "hidden" },
        {
          type: "text",
          text: '<attached-document label="Note">\nbody\n</attached-document>',
        },
        {
          type: "file",
          mediaType: "image/png",
          filename: "chart.png",
          data: { type: "url", url: "data:image/png;base64,AAAA" },
        },
      ],
    },
  ]);
  expect(modelHistoryOf(page, "assistant", "msg_a")).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Answer" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "resource_read",
          input: { resource: "dashboard" },
        },
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "resource_read",
          input: { q: 1 },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "resource_read",
          output: { type: "json", value: { status: "ok" } },
        },
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "resource_read",
          output: { type: "error-text", value: "boom" },
        },
      ],
    },
  ]);
  expect(modelHistoryOf(page, "assistant", "msg_e")).toEqual([]);
  expect(textOf(page)).not.toContain("thinking");
});

test("retains failed output and pairs unfinished tools in transcript reads", async () => {
  const failed = assistant("msg_failed", [text("msg_failed", "failed output")]);
  if (failed.info.role !== "assistant") throw new Error("Expected assistant");
  failed.info.error = { name: "UnknownError", data: { message: "failed" } };
  const running = assistant("msg_running", [
    {
      id: `prt_${ascending()}`,
      messageID: "msg_running",
      type: "tool",
      childSessionIds: [],
      tool: "resource_read",
      callID: "call_running",
      state: {
        status: "running",
        input: { resource: "dashboard" },
        time: { start: 1 },
      },
    },
  ]);
  await runtime.runPromise(
    seed(SOURCE, "Replay", [
      [failed, 1000],
      [running, 2000],
    ]),
  );
  const page = await read({ session_id: SOURCE, cursor: null });
  expect(modelHistoryOf(page, "assistant", "msg_failed")).toEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "failed output" }],
    },
  ]);
  expect(modelHistoryOf(page, "assistant", "msg_running")).toMatchObject([
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_running" }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_running",
          output: {
            type: "error-text",
            value: "[Tool execution was interrupted]",
          },
        },
      ],
    },
  ]);
});

test("honors the newest session reference in the caller transcript as an inclusive bound", async () => {
  await runtime.runPromise(seed(SOURCE, "Rates outlook", conversation));
  const reference = (throughCreatedAt: number): WithParts =>
    user(
      `msg_${ascending()}`,
      [
        {
          id: `prt_${ascending()}`,
          messageID: "msg_ref",
          type: "context",
          context: {
            kind: "session",
            sessionId: SOURCE,
            throughCreatedAt: new Date(throughCreatedAt).toISOString(),
          },
        },
      ],
      "ses_caller",
    );
  const page = await read(
    { session_id: SOURCE, cursor: null },
    { ...context, messages: [reference(4000), reference(3000)] },
  );
  expect(page.metadata).toMatchObject({
    messages: 3,
    hasMore: false,
    throughCreatedAt: 3000,
  });
  expect(textOf(page)).toContain("--- user msg_3 ---");
  expect(textOf(page)).not.toContain("msg_4");
});

test("asks for read_transcript permission before reading and propagates refusal", async () => {
  await runtime.runPromise(seed(SOURCE, "Rates outlook", conversation));
  await read({ session_id: SOURCE, cursor: null });
  expect(ask).toHaveBeenCalledExactlyOnceWith({
    permission: "read_transcript",
    patterns: [SOURCE],
    always: [SOURCE],
    metadata: { session_id: SOURCE },
  });
  const exit = await readResult(
    { session_id: SOURCE, cursor: null },
    { ...context, ask: () => Effect.fail("denied") },
  );
  expect(failure(exit)).toBe("denied");
});

test("fails with readable errors for unknown sessions and unrecognized cursors", async () => {
  await runtime.runPromise(seed(SOURCE, "Rates outlook", conversation));
  await runtime.runPromise(
    seed("ses_other", "Other", [
      [user("msg_o1", [text("msg_o1", "a")], "ses_other"), 1000],
      [user("msg_o2", [text("msg_o2", "b")], "ses_other"), 2000],
    ]),
  );
  const missing = failure(
    await readResult({ session_id: "ses_missing", cursor: null }),
  );
  expect(missing).toBeInstanceOf(StoreNotFound);
  expect((missing as StoreNotFound).message).toBe(
    "session ses_missing was not found",
  );

  const malformed = failure(
    await readResult({ session_id: SOURCE, cursor: "not-a-cursor" }),
  );
  expect(malformed).toBeInstanceOf(InvalidCursor);
  expect((malformed as InvalidCursor).message).toContain(
    "Pass only the exact next cursor",
  );

  const other = await read({ session_id: "ses_other", cursor: null, limit: 1 });
  const foreign = failure(
    await readResult({ session_id: SOURCE, cursor: other.metadata.nextCursor }),
  );
  expect(foreign).toBeInstanceOf(InvalidCursor);
});

test("returns a single oversized Part intact", async () => {
  const value = "é".repeat(PAGE_BYTE_BUDGET);
  await runtime.runPromise(
    seed(SOURCE, "Big", [[user("msg_big", [text("msg_big", value)]), 1000]]),
  );
  const page = await read({ session_id: SOURCE, cursor: null });
  expect(page.metadata).toMatchObject({
    contentTruncated: false,
    hasMore: false,
    nextCursor: null,
  });
  expect(modelHistoryOf(page, "user", "msg_big")).toEqual([
    { role: "user", content: [{ type: "text", text: value }] },
  ]);
  expect(textOf(page)).not.toContain("[Content truncated");
});

test("shows earlier read_transcript results as pointers, so chained reads stay the same size", async () => {
  // Each day reads the previous day's Session, like a scheduled follower.
  let previous = "ses_day0";
  await runtime.runPromise(
    seed(previous, "Day 0", [
      [
        assistant("msg_day0", [text("msg_day0", 'ledger "day 0"')], previous),
        1000,
      ],
    ]),
  );
  const sizes: number[] = [];
  for (const day of [1, 2, 3]) {
    const page = await read({ session_id: previous, cursor: null });
    sizes.push(textOf(page).length);
    const sessionID = `ses_day${day}`;
    const messageID = `msg_day${day}`;
    const stored: ToolPart = {
      id: `prt_${ascending()}`,
      messageID,
      type: "tool",
      childSessionIds: [],
      tool: "read_transcript",
      callID: `call_${day}`,
      state: {
        status: "completed",
        input: { session_id: previous, cursor: null },
        output: page.output,
        title: page.title,
        metadata: page.metadata,
        time: { start: 1, end: 2 },
      },
    };
    await runtime.runPromise(
      seed(sessionID, `Day ${day}`, [
        [assistant(messageID, [stored], sessionID), 1000],
      ]),
    );
    previous = sessionID;
  }
  const last = await read({ session_id: previous, cursor: null });
  sizes.push(textOf(last).length);

  expect(modelHistoryOf(last, "assistant", "msg_day3")).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_3",
          toolName: "read_transcript",
          input: { session_id: "ses_day2", cursor: null },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_3",
          toolName: "read_transcript",
          output: {
            type: "text",
            value:
              "[Copy of session ses_day2 omitted; read that session directly with read_transcript.]",
          },
        },
      ],
    },
  ]);
  expect(textOf(last)).not.toContain("day 0");
  // Embedded copies were re-escaped on every read and doubled per day.
  expect(sizes.slice(1)).toEqual([sizes[1], sizes[1], sizes[1]]);
});

test("resumes whole Parts without skipping or repeating content, then continues older messages", async () => {
  const values = ["first", "tool", "middle", "final"].map(
    (label) => label + ":" + "x".repeat(6000),
  );
  const tool: ToolPart = {
    id: `prt_${ascending()}`,
    messageID: "msg_long",
    type: "tool",
    childSessionIds: [],
    tool: "resource_read",
    callID: "call_long",
    state: {
      status: "completed",
      input: { resource: "dashboard" },
      output: { type: "text", value: values[1]! },
      title: "Read",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  const firstText = { ...text("msg_long", values[0]!), id: "prt_000_first" };
  const long = assistant("msg_long", [
    firstText,
    tool,
    text("msg_long", values[2]!),
    text("msg_long", values[3]!),
    {
      id: `prt_${ascending()}`,
      messageID: "msg_long",
      type: "reasoning",
      text: "hidden".repeat(10000),
      time: { start: 1 },
    },
  ]);
  await runtime.runPromise(
    seed(SOURCE, "Long research", [
      [user("msg_old", [text("msg_old", "old question")]), 1000],
      [long, 2000],
      [user("msg_new", [text("msg_new", "new question")]), 3000],
    ]),
  );

  const first = await read({ session_id: SOURCE, cursor: null, limit: 2 });
  expect(first.metadata).toMatchObject({
    messages: 2,
    hasMore: true,
    contentTruncated: false,
  });
  expect(modelHistoryOf(first, "assistant", "msg_long")).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: values[2] },
        { type: "text", text: values[3] },
      ],
    },
  ]);
  expect(textOf(first)).toContain("new question");
  expect(textOf(first)).not.toContain("hidden");

  // A larger limit preserves the Part boundary without filling the page with older messages.
  const second = await read({
    session_id: SOURCE,
    cursor: first.metadata.nextCursor,
    limit: 3,
  });
  expect(second.metadata).toMatchObject({
    messages: 1,
    hasMore: true,
    contentTruncated: false,
  });
  expect(modelHistoryOf(second, "assistant", "msg_long")).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: values[0] },
        {
          type: "tool-call",
          toolCallId: "call_long",
          toolName: "resource_read",
          input: { resource: "dashboard" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_long",
          toolName: "resource_read",
          output: { type: "text", value: values[1] },
        },
      ],
    },
  ]);
  const third = await read({
    session_id: SOURCE,
    cursor: second.metadata.nextCursor,
  });
  expect(third.metadata).toMatchObject({
    messages: 1,
    hasMore: false,
    nextCursor: null,
  });
  expect(textOf(third)).toContain("old question");
  expect(textOf(third)).not.toContain("msg_long");
});

test("keeps oversized Parts on separate pages and retains around and snapshot bounds on continuation", async () => {
  const values = ["a", "b", "c"].map((label) => label.repeat(PAGE_BYTE_BUDGET));
  await runtime.runPromise(
    seed(SOURCE, "Bounded", [
      [user("msg_before", [text("msg_before", "before")]), 1000],
      [
        assistant(
          "msg_long",
          values.map((value) => text("msg_long", value)),
        ),
        2000,
      ],
      [user("msg_after", [text("msg_after", "after")]), 3000],
    ]),
  );
  const ctx = {
    ...context,
    messages: [
      user(
        "msg_ref",
        [
          {
            id: `prt_${ascending()}`,
            messageID: "msg_ref",
            type: "context",
            context: {
              kind: "session",
              sessionId: SOURCE,
              throughCreatedAt: new Date(2000).toISOString(),
            },
          },
        ],
        "ses_caller",
      ),
    ],
  };
  let page = await read(
    {
      session_id: SOURCE,
      cursor: null,
      around_message_id: "msg_long",
      limit: 1,
    },
    ctx,
  );
  for (const value of [...values].reverse()) {
    expect(page.metadata).toMatchObject({
      messages: 1,
      hasMore: true,
      contentTruncated: false,
      throughCreatedAt: 2000,
    });
    expect(modelHistoryOf(page, "assistant", "msg_long")).toEqual([
      { role: "assistant", content: [{ type: "text", text: value }] },
    ]);
    expect(textOf(page)).not.toContain("msg_after");
    page = await read(
      { session_id: SOURCE, cursor: page.metadata.nextCursor },
      ctx,
    );
  }
  expect(page.metadata).toMatchObject({ hasMore: false, nextCursor: null });
  expect(textOf(page)).toContain("before");
  expect(textOf(page)).not.toContain("msg_after");
});

test("rejects a Part cursor used for another Session", async () => {
  await runtime.runPromise(
    seed(SOURCE, "Long", [
      [
        assistant("msg_long", [
          text("msg_long", "a".repeat(PAGE_BYTE_BUDGET)),
          text("msg_long", "b".repeat(PAGE_BYTE_BUDGET)),
        ]),
        1000,
      ],
    ]),
  );
  await runtime.runPromise(seed("ses_other", "Other", []));
  const first = await read({ session_id: SOURCE, cursor: null });
  expect(first.metadata.nextCursor).not.toBeNull();
  expect(
    failure(
      await readResult({
        session_id: "ses_other",
        cursor: first.metadata.nextCursor,
      }),
    ),
  ).toBeInstanceOf(InvalidCursor);
});

test("retains document evidence when its source Part is on a later page", async () => {
  const document: ContextPart = {
    id: `prt_${ascending()}`,
    messageID: "msg_doc",
    type: "context",
    context: {
      kind: "document",
      title: "Source",
      text: "document body",
      evidence: [
        {
          source: {
            kind: "web_search_result",
            title: "Source",
            url: "https://example.com/source",
            hostname: "example.com",
          },
          blocks: [{ kind: "excerpt", text: "document evidence" }],
        },
      ],
    },
  };
  if (document.context.kind !== "document")
    throw new Error("Expected document context");
  const evidence = prepareEvidence(document.context.evidence!, document, 1);
  await runtime.runPromise(
    seed(SOURCE, "Evidence", [
      [
        user("msg_doc", [
          document,
          ...evidence.parts,
          text("msg_doc", "large tail".repeat(PAGE_BYTE_BUDGET)),
        ]),
        1000,
      ],
    ]),
  );
  const first = await read({ session_id: SOURCE, cursor: null });
  expect(first.metadata.hasMore).toBe(true);
  expect(textOf(first)).not.toContain("document evidence");
  const second = await read({
    session_id: SOURCE,
    cursor: first.metadata.nextCursor,
  });
  expect(second.metadata).toMatchObject({ hasMore: false, nextCursor: null });
  expect(textOf(second)).toContain("document body");
  expect(textOf(second)).toContain("document evidence");
  expect(textOf(second)).toContain(evidence.parts[0]!.evidenceID);
  expect(textOf(second)).not.toContain("large tail");
  expect(modelHistoryOf(second, "user", "msg_doc")).toHaveLength(1);
});

test.each([
  { session_id: SOURCE },
  { session_id: "bad", cursor: null },
  { session_id: SOURCE, cursor: "0", limit: 0 },
  { session_id: SOURCE, cursor: null, extra: true },
])("rejects arguments %j before any read", async (input) => {
  const error = failure(await readResult(input));
  expect(error).toBeInstanceOf(InvalidArgumentsError);
  expect(ask).not.toHaveBeenCalled();
});

test("centers the first page on around_message_id and continues older", async () => {
  await runtime.runPromise(seed(SOURCE, "Rates outlook", conversation));
  const centered = await read({
    session_id: SOURCE,
    cursor: null,
    around_message_id: "msg_3",
    limit: 3,
  });
  expect(centered.metadata).toMatchObject({ messages: 3, hasMore: true });
  expect(textOf(centered).match(/--- (?:user|assistant) msg_\d ---/g)).toEqual([
    "--- assistant msg_2 ---",
    "--- user msg_3 ---",
    "--- assistant msg_4 ---",
  ]);
  expect(textOf(centered)).not.toContain("msg_5");
  const older = await read({
    session_id: SOURCE,
    cursor: centered.metadata.nextCursor,
    limit: 3,
  });
  expect(textOf(older)).toContain("--- user msg_1 ---");
  expect(older.metadata).toMatchObject({ messages: 1, hasMore: false });

  const missing = failure(
    await readResult({
      session_id: SOURCE,
      cursor: null,
      around_message_id: "msg_nope",
    }),
  );
  expect(missing).toBeInstanceOf(StoreNotFound);
  expect((missing as StoreNotFound).message).toBe(
    "message msg_nope was not found",
  );
  expect(
    failure(
      await readResult({
        session_id: SOURCE,
        cursor: centered.metadata.nextCursor,
        around_message_id: "msg_3",
      }),
    ),
  ).toBeInstanceOf(InvalidArgumentsError);
});

test("projects the model-facing parameter schema", () => {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(Parameters),
  );
  expect(document.schema).toMatchObject({
    type: "object",
    required: ["session_id", "cursor"],
    additionalProperties: false,
  });
  expect(Object.keys(document.schema.properties ?? {})).toEqual([
    "session_id",
    "cursor",
    "limit",
    "around_message_id",
  ]);
});
