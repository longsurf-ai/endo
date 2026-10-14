// Purpose: Verifies prompt history selection against committed, paginated Session data.

import type {
  Assistant,
  User,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import { ascending } from "@openchart/identifier";
import { Session } from "@openchart/server/agent/session/session";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { run } from "@openchart/server/agent/processor/processor.test-utils";
import {
  derivePromptLoopAnchors,
  isNaturalReplyForUser,
  prepareStepHistory,
  readHistory,
} from "./history";

function userMessage(id: string): WithParts & { info: User } {
  return {
    info: {
      id,
      sessionID: "session",
      role: "user",
      agent: "analyst",
      model: { providerID: "openai", modelID: "test" },
      time: { created: 1 },
    },
    parts: [{ id: `${id}-text`, messageID: id, type: "text", text: id }],
  };
}

function assistantMessage(
  id: string,
  userID: string,
  finish?: string,
): WithParts & { info: Assistant } {
  return {
    info: {
      id,
      sessionID: "session",
      role: "assistant",
      triggeringUserMessageID: userID,
      agent: "analyst",
      providerID: "openai",
      modelID: "test",
      path: { cwd: "/", root: "/" },
      time: { created: 1 },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...(finish ? { finish } : {}),
    },
    parts: [{ id: `${id}-text`, messageID: id, type: "text", text: id }],
  };
}

test("derives distinct loop anchors from storage order without changing history", () => {
  const previous = userMessage("z-previous");
  const finished = assistantMessage("y-finished", previous.info.id, "stop");
  const latest = userMessage("b-latest");
  const unfinished = assistantMessage("a-unfinished", latest.info.id);
  const messages = Object.freeze([previous, finished, latest, unfinished]);
  const before = structuredClone(messages);
  const anchors = derivePromptLoopAnchors(messages);
  expect(anchors.lastUser).toBe(latest.info);
  expect(anchors.lastAssistant).toBe(unfinished.info);
  expect(anchors.lastFinished).toBe(finished.info);
  expect(messages).toEqual(before);
});

test("missing loop anchors remain absent", () => {
  const user = userMessage("user");
  const assistant = assistantMessage("assistant", user.info.id);
  expect(derivePromptLoopAnchors([])).toEqual({
    lastUser: undefined,
    lastAssistant: undefined,
    lastFinished: undefined,
  });
  expect(derivePromptLoopAnchors([user])).toEqual({
    lastUser: user.info,
    lastAssistant: undefined,
    lastFinished: undefined,
  });
  expect(derivePromptLoopAnchors([assistant])).toEqual({
    lastUser: undefined,
    lastAssistant: assistant.info,
    lastFinished: undefined,
  });
});

test("step replay wraps only new visible user text and preserves committed parts", () => {
  const previous = userMessage("z-previous");
  const finished = assistantMessage(
    "m-finished",
    previous.info.id,
    "tool-calls",
  );
  const latest = userMessage("a-latest");
  latest.parts.push(
    {
      id: "synthetic",
      messageID: latest.info.id,
      type: "text",
      text: "Synthetic input",
      synthetic: true,
    },
    { id: "blank", messageID: latest.info.id, type: "text", text: "  " },
    {
      id: "file",
      messageID: latest.info.id,
      type: "file",
      mime: "image/png",
      url: "https://example.com/image.png",
    },
  );
  const unfinished = assistantMessage("unfinished", latest.info.id);
  const messages = Object.freeze([previous, finished, latest, unfinished]);
  const before = structuredClone(messages);
  const history = prepareStepHistory({
    messages,
    lastFinished: finished.info,
    step: 2,
  });
  expect(history[2]?.parts[0]).toMatchObject({
    text: [
      "<system-reminder>",
      "The user sent the following message:",
      latest.info.id,
      "",
      "Please address this message and continue with your tasks.",
      "</system-reminder>",
    ].join("\n"),
  });
  expect(history[0]).toEqual(previous);
  expect(history[1]).toEqual(finished);
  expect(history[2]?.parts.slice(1)).toEqual(latest.parts.slice(1));
  expect(history[3]).toEqual(unfinished);
  expect(messages).toEqual(before);
  expect(history[0]).not.toBe(previous);
  expect(
    prepareStepHistory({ messages, lastFinished: finished.info, step: 1 }),
  ).toEqual(before);
  expect(prepareStepHistory({ messages, step: 2 })).toEqual(before);
});

test("natural completion follows the triggering user and excludes unfinished tool turns", () => {
  for (const finish of [undefined, "tool-calls", "unknown"])
    expect(
      isNaturalReplyForUser("user", {
        finish,
        triggeringUserMessageID: "user",
      }),
    ).toBe(false);
  expect(
    isNaturalReplyForUser("user", {
      finish: "stop",
      triggeringUserMessageID: "other",
    }),
  ).toBe(false);
  expect(
    isNaturalReplyForUser("user", {
      finish: "stop",
      triggeringUserMessageID: "user",
    }),
  ).toBe(true);
});

test("reads complete storage pages and retains the matching compaction marker", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const session = yield* Session.Service;
      const marker: User = {
        id: `msg_${ascending()}`,
        role: "user",
        sessionID: fixture.assistant.sessionID,
        agent: "analyst",
        model: fixture.request.user.model,
        time: { created: 900 },
      };
      yield* session.createMessage({
        info: marker,
        parts: [
          {
            id: `prt_${ascending()}`,
            messageID: marker.id,
            type: "compaction",
            auto: true,
          },
        ],
      });
      const summary: Assistant = {
        ...fixture.assistant,
        id: `msg_${ascending()}`,
        triggeringUserMessageID: marker.id,
        agent: "compaction",
        finish: "stop",
        summary: true,
      };
      yield* session.createMessage({
        info: summary,
        parts: [
          {
            id: `prt_${ascending()}`,
            messageID: summary.id,
            type: "text",
            text: "Useful summary",
          },
        ],
      });
      const expected = [marker.id, summary.id];
      for (let index = 0; index < 105; index++) {
        const user = {
          ...marker,
          id: `msg_${ascending()}`,
          time: { created: 105 - index },
        };
        yield* session.createMessage({
          info: user,
          parts: [
            {
              id: `prt_${ascending()}`,
              messageID: user.id,
              type: "text",
              text: `${index}`,
            },
          ],
        });
        expected.push(user.id);
      }
      const history = yield* readHistory(marker.sessionID);
      expect(history.map((message) => message.info.id)).toEqual(expected);
      expect(history.every((message) => message.parts.length === 1)).toBe(true);
    }),
  );
});

test.each(
  [true, false].flatMap((auto) =>
    ["unsealed", "empty", "length", "error", "wrong-parent", "no-marker"].map(
      (failure) => ({ auto, failure }),
    ),
  ),
)(
  "$failure summaries retain history and headers (auto: $auto)",
  async ({ auto, failure }) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const marker: User = {
          id: `msg_${ascending()}`,
          role: "user",
          sessionID: fixture.assistant.sessionID,
          agent: "analyst",
          model: fixture.request.user.model,
          time: { created: 1 },
        };
        yield* fixture.session.createMessage({
          info: marker,
          parts:
            failure === "no-marker"
              ? []
              : [
                  {
                    id: `prt_${ascending()}`,
                    messageID: marker.id,
                    type: "compaction",
                    auto,
                  },
                ],
        });
        const summary: Assistant = {
          ...fixture.assistant,
          id: `msg_${ascending()}`,
          triggeringUserMessageID:
            failure === "wrong-parent" ? "missing" : marker.id,
          agent: "compaction",
          finish: failure === "length" ? "length" : "stop",
          summary: failure !== "unsealed",
          ...(failure === "error"
            ? {
                error: {
                  name: "UnknownError" as const,
                  data: { message: "Failed" },
                },
              }
            : {}),
        };
        yield* fixture.session.createMessage({
          info: summary,
          parts: [
            {
              id: `prt_${ascending()}`,
              messageID: summary.id,
              type: "text",
              text: failure === "empty" ? "  " : "Summary",
            },
          ],
        });
        const history = yield* readHistory(marker.sessionID);
        expect(history.slice(0, 2).map((message) => message.info.id)).toEqual(
          expect.arrayContaining([
            fixture.assistant.triggeringUserMessageID,
            fixture.assistant.id,
          ]),
        );
        expect(history.some((message) => message.info.id === marker.id)).toBe(
          true,
        );
        const replayed = history.find(
          (message) => message.info.id === summary.id,
        );
        expect(replayed?.info).toEqual(summary);
        expect(replayed?.parts).toHaveLength(
          failure === "wrong-parent" || failure === "no-marker" ? 1 : 0,
        );
        const stored = yield* fixture.session.getMessage({
          sessionID: marker.sessionID,
          messageID: summary.id,
        });
        expect(stored?.parts).toHaveLength(1);
      }),
    );
  },
);
