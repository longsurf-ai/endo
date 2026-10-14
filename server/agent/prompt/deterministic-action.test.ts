// Purpose: Verifies one shared transcript boundary for deterministic Part selection.

import type {
  Assistant,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import type {
  CompactionPart,
  SubtaskPart,
  WorkflowPart,
} from "@openchart/server/agent/contracts/part";
import { model } from "@openchart/server/agent/processor/processor.test-utils";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { nextDeterministicAction } from "./deterministic-action";

const parts: (WorkflowPart | SubtaskPart | CompactionPart)[] = [
  {
    type: "workflow",
    id: "workflow",
    messageID: "user",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: {},
  },
  {
    type: "subtask",
    id: "subtask",
    messageID: "user",
    agent: "analyst",
    prompt: "Research",
    description: "Research",
  },
  { type: "compaction", id: "compaction", messageID: "user", auto: false },
];

function userMessage(parts: WithParts["parts"], id = "user"): WithParts {
  return {
    info: {
      id,
      sessionID: "session",
      role: "user",
      agent: "analyst",
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: 10 },
    },
    parts,
  };
}

function assistantMessage(finish?: string, completed?: number): WithParts {
  const info: Assistant = {
    id: "assistant",
    sessionID: "session",
    role: "assistant",
    triggeringUserMessageID: "user",
    agent: "analyst",
    providerID: model.providerID,
    modelID: model.id,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, ...(completed === undefined ? {} : { completed }) },
    ...(finish === undefined ? {} : { finish }),
  };
  return { info, parts: [] };
}

test.each(parts)(
  "$type remains pending until an Assistant finishes",
  async (part) => {
    const messages = [userMessage([part]), assistantMessage()];
    const before = structuredClone(messages);
    expect(
      await Effect.runPromise(nextDeterministicAction({ messages, model })),
    ).toBe(part);
    expect(messages).toEqual(before);
  },
);

test.each(parts)(
  "$type is not selected again after a finished or terminal Assistant",
  async (part) => {
    for (const assistant of [
      assistantMessage("tool-calls"),
      assistantMessage("stop"),
      assistantMessage(undefined, 0),
    ]) {
      const messages = [userMessage([part]), assistant, assistantMessage()];
      expect(
        await Effect.runPromise(nextDeterministicAction({ messages, model })),
      ).toBeUndefined();
    }
  },
);

test.each(parts)(
  "$type after the boundary retains its owning Part even with later user text",
  async (part) => {
    const intent = { ...part, id: `new-${part.id}`, messageID: "new-user" };
    const messages = [
      userMessage(parts),
      assistantMessage("tool-calls"),
      userMessage([intent], "new-user"),
      userMessage(
        [
          {
            id: "text",
            messageID: "later-user",
            type: "text",
            text: "Continue",
          },
        ],
        "later-user",
      ),
    ];
    expect(
      await Effect.runPromise(nextDeterministicAction({ messages, model })),
    ).toBe(intent);
  },
);

test("rejects multiple pending Parts instead of silently skipping work", async () => {
  await expect(
    Effect.runPromise(
      nextDeterministicAction({
        messages: [userMessage(parts)],
        model,
      }),
    ),
  ).rejects.toThrow("At most one deterministic action Part may be pending");
});

test("selects pending Parts before automatic compaction, then uses its ordinary trigger", async () => {
  const messages = [
    userMessage([
      { id: "text", messageID: "user", type: "text", text: "Large history" },
    ]),
    assistantMessage("tool-calls"),
  ];
  const smallModel = { ...model, limit: { context: 10, input: 1, output: 1 } };
  expect(
    await Effect.runPromise(
      nextDeterministicAction({ messages, model: smallModel }),
    ),
  ).toEqual({ type: "auto-compaction" });
  const part: WorkflowPart = {
    type: "workflow",
    id: "new-workflow",
    messageID: "new-user",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: {},
  };
  messages.push(userMessage([part], "new-user"));
  expect(
    await Effect.runPromise(
      nextDeterministicAction({ messages, model: smallModel }),
    ),
  ).toBe(part);
});
