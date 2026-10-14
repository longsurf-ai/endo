// Purpose: Verifies search_transcript ranking, exclusion, projection-based matching, paging, and failures.

import { ascending } from "@openchart/identifier";
import type { ContextPart } from "@openchart/server/agent/contracts/part";
import { prepareEvidence } from "@openchart/server/agent/session/message/evidence";
import { InvalidArgumentsError } from "@openchart/server/agent/tool/errors";
import * as Tool from "@openchart/server/agent/tool/tool";
import { Effect, Result } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InvalidCursor } from "./errors";
import { ReadTranscriptTool } from "./read-transcript";
import {
  MAX_MATCHES_PER_SESSION,
  SearchTranscriptTool,
  snippet,
} from "./search-transcript";
import {
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
  metadata: () => Effect.die("search_transcript must not report progress"),
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

const search = (input: unknown, ctx: Tool.Context = context) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SearchTranscriptTool);
      return yield* Effect.result(tool.execute(input, ctx));
    }),
  );
type Page = {
  items: {
    sessionId: string;
    title: string;
    kind: string;
    updatedAt: string;
    matches: { messageId: string; role: string; snippet: string }[];
  }[];
  nextCursor: string | null;
};
const ok = async (input: unknown, ctx: Tool.Context = context) => {
  const result = await search(input, ctx);
  if (Result.isFailure(result)) throw result.failure;
  if (result.success.output.type !== "json")
    throw new Error("Expected JSON output");
  return {
    ...result.success,
    json: result.success.output.value as unknown as Page,
  };
};
const failure = (result: Result.Result<unknown, unknown>) => {
  if (!Result.isFailure(result)) throw new Error("Expected a failure");
  return result.failure;
};

/** A single-message chat Session containing the given text. */
const conversation = (
  sessionID: string,
  title: string,
  content: string,
  options: Parameters<typeof seed>[3] = {},
) =>
  seed(
    sessionID,
    title,
    [
      [
        user(
          `msg_${sessionID.slice(4)}`,
          [text(`msg_${sessionID.slice(4)}`, content)],
          sessionID,
        ),
        1000,
      ],
    ],
    options,
  );

test("lists matching sessions newest first with kind and snippets, excluding the caller's own session", async () => {
  await runtime.runPromise(
    Effect.all([
      conversation(
        "ses_a",
        "Rates outlook",
        "Rates outlook for 2026 looks steady",
        {
          updatedAt: 1000,
        },
      ),
      conversation("ses_b", "Research", "Research rates now", {
        kind: "delegate",
        updatedAt: 3000,
      }),
      conversation("ses_caller", "Mine", "rates in my own session", {
        updatedAt: 5000,
      }),
      conversation("ses_c", "Quiet", "nothing here", { updatedAt: 2000 }),
    ]),
  );
  const page = await ok({ query: "rates" });
  expect(page.title).toBe("Search transcripts");
  expect(page.metadata).toEqual({
    query: "rates",
    sessions: 2,
    hasMore: false,
    nextCursor: null,
  });
  expect(page.json).toEqual({
    items: [
      {
        sessionId: "ses_b",
        title: "Research",
        kind: "delegate",
        updatedAt: new Date(3000).toISOString(),
        matches: [
          {
            messageId: "msg_b",
            role: "user",
            snippet: expect.stringContaining("Research rates now"),
          },
        ],
      },
      {
        sessionId: "ses_a",
        title: "Rates outlook",
        kind: "chat",
        updatedAt: new Date(1000).toISOString(),
        matches: [
          {
            messageId: "msg_a",
            role: "user",
            snippet: expect.stringContaining(
              "Rates outlook for 2026 looks steady",
            ),
          },
        ],
      },
    ],
    nextCursor: null,
  });
});

test("pages sessions through the returned cursor", async () => {
  await runtime.runPromise(
    Effect.all([
      conversation("ses_a", "A", "alpha one", { updatedAt: 1000 }),
      conversation("ses_b", "B", "alpha two", { updatedAt: 2000 }),
      conversation("ses_c", "C", "alpha three", { updatedAt: 3000 }),
    ]),
  );
  const first = await ok({ query: "alpha", limit: 2 });
  expect(first.json).toMatchObject({
    items: [{ sessionId: "ses_c" }, { sessionId: "ses_b" }],
    nextCursor: expect.any(String),
  });
  const second = await ok({
    query: "alpha",
    limit: 2,
    cursor: first.metadata.nextCursor,
  });
  expect(second.json).toEqual({
    items: [
      {
        sessionId: "ses_a",
        title: "A",
        kind: "chat",
        updatedAt: new Date(1000).toISOString(),
        matches: [
          {
            messageId: "msg_a",
            role: "user",
            snippet: expect.stringContaining("alpha one"),
          },
        ],
      },
    ],
    nextCursor: null,
  });
});

test("matches only the text read_transcript would show", async () => {
  const answer = assistant(
    "msg_a",
    [
      {
        id: `prt_${ascending()}`,
        messageID: "msg_a",
        type: "reasoning",
        text: "delta hedging",
        time: { start: 1 },
      },
      text("msg_a", "epsilon", true),
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
          output: { type: "json", value: { note: "gamma exposure" } },
          title: "zeta title",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
      text("msg_a", "Visible answer"),
    ],
    "ses_a",
  );
  await runtime.runPromise(seed("ses_a", "Projection", [[answer, 1000]]));

  const gamma = await ok({ query: "gamma exposure" });
  expect(gamma.json).toMatchObject({
    items: [
      {
        sessionId: "ses_a",
        matches: [
          {
            messageId: "msg_a",
            role: "assistant",
            snippet: expect.stringContaining('"note": "gamma exposure"'),
          },
        ],
      },
    ],
  });

  expect((await ok({ query: "epsilon" })).json.items).toHaveLength(1);

  for (const hidden of ["delta hedging", "zeta title"]) {
    expect((await ok({ query: hidden })).json).toEqual({
      items: [],
      nextCursor: null,
    });
  }
});

test("projects complete evidence-backed messages once for both search and read", async () => {
  const document: ContextPart = {
    id: `prt_${ascending()}`,
    messageID: "msg_evidence",
    type: "context",
    context: {
      kind: "document",
      title: "Report",
      text: "Evidence needle framing",
      evidence: [
        {
          source: {
            kind: "web_search_result",
            title: "Source",
            url: "https://example.com/article",
            hostname: "example.com",
          },
          blocks: [{ kind: "excerpt", text: "Evidence needle source" }],
        },
      ],
    },
  };
  if (document.context.kind !== "document")
    throw new Error("Expected document context");
  const prepared = prepareEvidence(document.context.evidence!, document, 1);
  const message = user(
    "msg_evidence",
    [
      document,
      text("msg_evidence", "Evidence needle question"),
      ...prepared.parts,
    ],
    "ses_a",
  );
  await runtime.runPromise(seed("ses_a", "Evidence", [[message, 1000]]));
  const page = await ok({ query: "evidence needle" });
  expect(page.json.items).toHaveLength(1);
  expect(page.json.items[0]!.matches).toEqual([
    {
      messageId: "msg_evidence",
      role: "user",
      snippet: expect.stringContaining("Evidence needle framing"),
    },
  ]);
  const read = await runtime.runPromise(
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReadTranscriptTool);
      return yield* tool.execute(
        { session_id: "ses_a", cursor: null },
        context,
      );
    }),
  );
  expect(read.output).toMatchObject({
    type: "text",
    value: expect.stringContaining("Evidence needle source"),
  });
  expect(read.output).toMatchObject({
    value: expect.stringContaining(prepared.parts[0]!.evidenceID),
  });
});

test("matches case-insensitively and treats LIKE wildcards literally", async () => {
  await runtime.runPromise(conversation("ses_a", "Moves", "Up 100% today"));
  expect((await ok({ query: "UP 100%" })).json.items).toHaveLength(1);
  expect((await ok({ query: "100_" })).json.items).toHaveLength(0);
  expect((await ok({ query: "100\\" })).json.items).toHaveLength(0);
});

test("keeps at most five snippets per session in transcript order", async () => {
  const messages = Array.from({ length: 7 }, (_, index) => {
    const id = `msg_${index}`;
    return [
      user(id, [text(id, `alpha ${index}`)], "ses_a"),
      1000 + index,
    ] as const;
  });
  await runtime.runPromise(seed("ses_a", "Many", messages));
  const page = await ok({ query: "alpha" });
  expect(page.json.items[0]!.matches).toHaveLength(MAX_MATCHES_PER_SESSION);
  expect(page.json.items[0]!.matches.map((match) => match.messageId)).toEqual([
    "msg_0",
    "msg_1",
    "msg_2",
    "msg_3",
    "msg_4",
  ]);
});

test("clips snippets around the first occurrence", () => {
  const long = `${"a".repeat(100)} rates ${"b".repeat(100)}`;
  expect(snippet(long, "RATES")).toBe(
    `…${"a".repeat(79)} rates ${"b".repeat(79)}…`,
  );
  expect(snippet("line one\n\n  rates\tnow", "rates")).toBe(
    "line one rates now",
  );
  expect(snippet("nothing", "rates")).toBeUndefined();
});

test("asks for search_transcript permission and fails on unknown cursors", async () => {
  await runtime.runPromise(conversation("ses_a", "A", "alpha"));
  await ok({ query: "alpha" });
  expect(ask).toHaveBeenCalledExactlyOnceWith({
    permission: "search_transcript",
    patterns: ["alpha"],
    always: ["*"],
    metadata: { query: "alpha" },
  });
  const error = failure(
    await search({ query: "alpha", cursor: "not-a-cursor" }),
  );
  expect(error).toBeInstanceOf(InvalidCursor);
  expect((error as InvalidCursor).message).toBe(
    "Invalid search_transcript cursor. Pass only the exact next cursor returned by a previous search_transcript call, or start over without one.",
  );
});

test.each([
  {},
  { query: "" },
  { query: "a", limit: 0 },
  { query: "a", extra: 1 },
])("rejects arguments %j before any read", async (input) => {
  expect(failure(await search(input))).toBeInstanceOf(InvalidArgumentsError);
  expect(ask).not.toHaveBeenCalled();
});
