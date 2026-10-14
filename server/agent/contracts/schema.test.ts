// Purpose: Locks Agent contract constraints and native URL and datetime normalization.

import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentPromptInput } from "./agent-prompt-input";
import * as Message from "./message";
import * as Part from "./part";
import { SessionAnchor } from "./session-anchor";

const identity = { id: "prt_1", messageID: "msg_1" };

describe("Agent schema contracts", () => {
  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite numbers: %s",
    (value) => {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(Part.TextPart)({
            ...identity,
            type: "text",
            text: "hello",
            time: { start: value },
          }),
        ),
      ).toBe(true);
    },
  );

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, -1])(
    "preserves nonnegative safe-integer constraints: %s",
    (value) => {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SessionAnchor)({
            partId: "prt_1",
            text: "selection",
            startOffset: value,
            endOffset: Number.MAX_SAFE_INTEGER,
            childSessionIds: ["ses_2"],
          }),
        ),
      ).toBe(true);
    },
  );

  it("strips extra fields inside a strict parent without weakening that parent", () => {
    const prompt = {
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [{ type: "text", text: "hello", extra: "discarded" }],
    };
    expect(Schema.decodeUnknownSync(AgentPromptInput)(prompt).parts).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(AgentPromptInput)({
          ...prompt,
          extra: true,
        }),
      ),
    ).toBe(true);
  });

  it("normalizes evidence URLs as strings and retains text trimming", () => {
    const source = Schema.decodeUnknownSync(Part.WebSearchEvidenceSource)({
      kind: "web_search_result",
      title: "  Source  ",
      hostname: "  example.com  ",
      url: "  https://exa\nmple.com:443/path  ",
    });
    expect(source).toEqual({
      kind: "web_search_result",
      title: "Source",
      hostname: "example.com",
      url: "https://example.com/path",
    });
    expect(Schema.encodeSync(Part.WebSearchEvidenceSource)(source)).toEqual(
      source,
    );
  });

  it.each(["invalid", "ftp://example.com/file"])(
    "rejects evidence URLs outside HTTP and HTTPS: %s",
    (url) => {
      expect(() =>
        Schema.decodeUnknownSync(Part.WebSearchEvidenceSource)({
          kind: "web_search_result",
          title: "Source",
          hostname: "example.com",
          url,
        }),
      ).toThrow();
    },
  );

  it("normalizes historical session cutoffs to UTC strings", () => {
    const context = Schema.decodeUnknownSync(Part.SessionContext)({
      kind: "session",
      sessionId: "ses_1",
      throughCreatedAt: "2024-01-01T08:00:00+08:00",
    });
    expect(context.throughCreatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(Schema.encodeSync(Part.SessionContext)(context)).toEqual(context);
  });

  it("requires an object for an empty error payload and strips its fields", () => {
    const parse = Schema.decodeUnknownSync(Message.OutputLengthError);
    const name = "MessageOutputLengthError";
    for (const data of [null, undefined, [], 1, "text"]) {
      expect(() => parse({ name, data })).toThrow();
    }
    expect(parse({ name, data: { extra: true } })).toStrictEqual({
      name,
      data: {},
    });
  });

  it("retains mutable fields, nested fields, arrays, and record values", () => {
    const input = {
      ...identity,
      type: "text",
      text: "original",
      time: { start: 1 },
      metadata: { key: 1 },
    };
    const part = Schema.decodeUnknownSync(Part.TextPart)(input);
    part.text = "edited";
    part.time!.start = 2;
    part.metadata!.key = 2;
    const request = Schema.decodeUnknownSync(Message.LlmRequest)({
      system: [],
      tools: [],
    });
    request.system.push("instruction");
    expect(input.text).toBe("original");
    expect(input.time.start).toBe(1);
    expect(input.metadata.key).toBe(1);
    expect(request.system).toEqual(["instruction"]);
  });
});
