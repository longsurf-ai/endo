// Purpose: Preserve work-cycle sequences across AG-UI live updates and history replay.
import type { ActivityMessage, Message } from "@ag-ui/core";
import { expect, test } from "vitest";
import {
  computerUseSequence,
  toolAttachments,
} from "@openchart/app/features/agent/ag-ui/tool-media";

function frame(id: string, screenshot = true): ActivityMessage {
  return {
    id,
    role: "activity",
    activityType: "openchart.tool",
    content: {
      toolCallId: id,
      status: "completed",
      attachments: [
        { id, mime: "image/png", url: `https://example.com/${id}.png` },
      ],
      details: screenshot ? { computerUse: { title: "Computer use" } } : {},
    },
  };
}
test("captures form an ordered sequence; ordinary images and text do not add steps", () => {
  const history: Message[] = [
    frame("first"),
    frame("second"),
    frame("ordinary", false),
    { id: "answer", role: "assistant", content: "Finished" },
  ];
  expect(computerUseSequence(history)?.frames.map(({ id }) => id)).toEqual([
    "first:first",
    "second:second",
  ]);
  expect(computerUseSequence(structuredClone(history))).toEqual(
    computerUseSequence(history),
  );
  expect(computerUseSequence([frame("ordinary", false)])).toBeUndefined();
  expect(computerUseSequence([])).toBeUndefined();
});
test("several images from one capture retain their order", () => {
  const capture = frame("capture");
  capture.content.attachments = [
    { id: "first", mime: "image/png", url: "https://example.com/first.png" },
    { id: "last", mime: "image/jpeg", url: "https://example.com/last.jpg" },
  ];
  expect(computerUseSequence([capture])?.frames.map(({ id }) => id)).toEqual([
    "capture:first",
    "capture:last",
  ]);
});

test.each(["Read 2 rows", null, ["progress"], 2, true])(
  "ordinary Activity details remain opaque: %j",
  (details) => {
    const ordinary = frame("ordinary", false);
    ordinary.content.details = details;
    expect(toolAttachments(ordinary.content)).toHaveLength(1);
    expect(computerUseSequence([ordinary])).toBeUndefined();
  },
);

test("a browser display-only screenshot supersedes the prior Calculator image", () => {
  const browser: ActivityMessage = {
    id: "browser",
    role: "activity",
    activityType: "openchart.tool",
    content: {
      toolCallId: "browser",
      status: "completed",
      attachments: [],
      details: {
        computerUse: {
          title: "Computer use",
          screenshot: {
            mime: "image/jpeg",
            url: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
          },
        },
      },
    },
  };
  expect(
    computerUseSequence([frame("calculator"), browser])?.frames.at(-1),
  ).toMatchObject({
    id: "browser:display-screenshot",
    url: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
  });
});

test("each user turn owns its screenshots; another work cycle starts empty", () => {
  const messages: Message[] = [
    { id: "first-turn", role: "user", content: "First work" },
    frame("old"),
    { id: "answer", role: "assistant", content: "Done" },
    { id: "second-turn", role: "user", content: "Second work" },
  ];
  expect(computerUseSequence(messages)).toBeUndefined();
  messages.push(frame("new"));
  messages.push({ id: "commentary", role: "assistant", content: "Continuing" });
  messages.push(frame("newer"));
  expect(computerUseSequence(messages)).toMatchObject({
    id: "second-turn",
    frames: [{ id: "new:new" }, { id: "newer:newer" }],
  });
  expect(computerUseSequence(structuredClone(messages))).toEqual(
    computerUseSequence(messages),
  );
});

test("delegated messages neither reset nor contribute frames to this view's work cycle", () => {
  const messages: Message[] = [
    { id: "turn", role: "user", content: "Work" },
    frame("first"),
    {
      id: "child-user",
      role: "user",
      content: "Child work",
      subagentRunId: "child",
    },
    { ...frame("child-screen"), subagentRunId: "child" },
    frame("second"),
  ];
  expect(computerUseSequence(messages)).toMatchObject({
    id: "turn",
    frames: [{ id: "first:first" }, { id: "second:second" }],
  });
});
