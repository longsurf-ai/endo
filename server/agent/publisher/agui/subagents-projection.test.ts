// Purpose: Locks delegate tree attribution, lifecycle ordering, and pure bootstrap projection.

import { EventType } from "@ag-ui/core";
import { WithParts } from "@openchart/server/agent/contracts/message";
import {
  SessionId,
  type Session,
} from "@openchart/server/agent/contracts/session";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { projectTree } from "./subagents";

function message(
  sessionID: string,
  role: "user" | "assistant",
  parts: object[],
  extra = {},
): WithParts {
  const id = `msg_${sessionID}_${role}`;
  return Schema.decodeUnknownSync(WithParts)({
    info: {
      id,
      sessionID,
      role,
      agent: "analyst",
      time: { created: 1 },
      ...(role === "user"
        ? { model: { providerID: "test", modelID: "test" } }
        : {
            triggeringUserMessageID: `msg_${sessionID}_user`,
            providerID: "test",
            modelID: "test",
            path: { cwd: "/test", root: "/test" },
            cost: 1,
            tokens: {
              input: 2,
              output: 3,
              reasoning: 4,
              cache: { read: 5, write: 6 },
            },
          }),
      ...extra,
    },
    parts: parts.map((part, index) => ({
      id: `prt_${sessionID}_${role}_${index}`,
      messageID: id,
      ...part,
    })),
  });
}

function transcript(
  id: string,
  history: WithParts[],
  parentId: string | null = null,
) {
  const session: Session = {
    id: SessionId.make(id),
    parentId,
    kind: parentId === null ? "chat" : "delegate",
    bindingId: null,
    anchors: null,
    title: `Title ${id}`,
    compactingAt: null,
    archivedAt: null,
    lastReadRunId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return { session, history };
}

function proxy(childSessionId: string) {
  return {
    type: "tool",
    tool: "Agent",
    callID: `call_${childSessionId}`,
    childSessionIds: [childSessionId],
    state: {
      status: "running",
      input: {},
      time: { start: 1 },
    },
  };
}

function branchingTree(completed = true) {
  const root = transcript("ses_root", [
    message("ses_root", "user", [{ type: "text", text: "Root question" }]),
    message(
      "ses_root",
      "assistant",
      [
        { type: "text", text: "Root answer" },
        proxy("ses_alpha"),
        proxy("ses_beta"),
      ],
      completed ? { time: { created: 1, completed: 2 } } : {},
    ),
  ]);
  const children = [
    [
      "ses_alpha",
      "ses_root",
      [{ type: "text", text: "Alpha" }, proxy("ses_nested")],
    ],
    ["ses_nested", "ses_alpha", [{ type: "text", text: "Nested" }]],
    ["ses_beta", "ses_root", [{ type: "text", text: "Beta" }]],
  ] as const;
  return new Map<string, ReturnType<typeof transcript>>([
    [root.session.id, root],
    ...children.map(
      ([id, parent, parts]) =>
        [
          id,
          transcript(
            id,
            [
              message(id, "user", [
                { type: "text", text: "Private child input" },
              ]),
              message(
                id,
                "assistant",
                [...parts],
                completed
                  ? { time: { created: 1, completed: 2 }, finish: "stop" }
                  : {},
              ),
            ],
            parent,
          ),
        ] as const,
    ),
  ]);
}

describe("projectTree", () => {
  test.each([["ses_child"], ["ses_child", "ses_other"]])(
    "keeps workflow child relationships out of native subagent projection: %j",
    (...childSessionIds) => {
      const trace = { resourceSpans: [] };
      const root = transcript("ses_root", [
        message("ses_root", "assistant", [
          {
            type: "tool",
            tool: "workflow",
            callID: "call_workflow",
            childSessionIds,
            state: {
              status: "running",
              input: {},
              metadata: { trace },
              time: { start: 1 },
            },
          },
        ]),
      ]);
      // No child transcript is loaded: workflow presentation is entirely its trace.
      const result = projectTree("ses_root", new Map([["ses_root", root]]));
      expect(result.lifecycle).toEqual([]);
      expect(Object.keys(result.messageInfo)).toEqual([
        "msg_ses_root_assistant",
      ]);
      const activity = result.messages.find(
        (message) => message.role === "activity",
      );
      expect(activity).toMatchObject({ content: { details: { trace } } });
      expect(activity?.content).not.toHaveProperty("childSessionId");
    },
  );

  test("projects an empty root without inventing a subagent lifecycle", () => {
    expect(
      projectTree(
        "ses_root",
        new Map([["ses_root", transcript("ses_root", [])]]),
      ),
    ).toEqual({ messages: [], messageInfo: {}, lifecycle: [], open: [] });
  });

  test("keeps root inputs and attributes every child message in depth-first link order", () => {
    const result = projectTree("ses_root", branchingTree());
    expect(
      result.messages.map(({ id, role, subagentRunId }) => [
        id,
        role,
        subagentRunId,
      ]),
    ).toEqual([
      ["msg_ses_root_user", "user", undefined],
      ["prt_ses_root_assistant_0", "assistant", undefined],
      ["prt_ses_root_assistant_1", "assistant", undefined],
      ["prt_ses_root_assistant_1:activity", "activity", undefined],
      ["prt_ses_root_assistant_2", "assistant", undefined],
      ["prt_ses_root_assistant_2:activity", "activity", undefined],
      ["prt_ses_alpha_assistant_0", "assistant", "prt_ses_root_assistant_1"],
      ["prt_ses_alpha_assistant_1", "assistant", "prt_ses_root_assistant_1"],
      [
        "prt_ses_alpha_assistant_1:activity",
        "activity",
        "prt_ses_root_assistant_1",
      ],
      ["prt_ses_nested_assistant_0", "assistant", "prt_ses_alpha_assistant_1"],
      ["prt_ses_beta_assistant_0", "assistant", "prt_ses_root_assistant_2"],
    ]);
    expect(
      result.messages
        .filter((item) => item.role === "assistant" && item.content)
        .map((item) => item.content),
    ).toEqual(["Root answer", "Alpha", "Nested", "Beta"]);
    expect(Object.keys(result.messageInfo)).toEqual([
      "msg_ses_root_user",
      "msg_ses_root_assistant",
      "msg_ses_alpha_assistant",
      "msg_ses_nested_assistant",
      "msg_ses_beta_assistant",
    ]);
    expect(result.messageInfo.msg_ses_nested_assistant).toEqual({
      workspaceRoot: "/test",
      completedAt: 2,
      error: null,
      finish: "stop",
      cost: 1,
      tokens: {
        input: 2,
        output: 3,
        reasoning: 4,
        cache: { read: 5, write: 6 },
      },
    });
    expect(result.open).toEqual([]);
  });

  test("encloses each nested lifecycle in its parent and preserves sibling order", () => {
    const tree = branchingTree();
    for (const transcript of tree.values())
      for (const part of transcript.history.flatMap((message) => message.parts))
        if (part.type === "tool")
          part.state = {
            status: "completed",
            input: {},
            output: { type: "text", value: "Done" },
            title: "Done",
            metadata: {},
            time: { start: 1, end: 2 },
          };
    expect(projectTree("ses_root", tree).lifecycle).toEqual([
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "prt_ses_root_assistant_1",
        name: "Title ses_alpha",
        parentToolCallId: "call_ses_alpha",
        parentMessageId: "prt_ses_root_assistant_1",
      },
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "prt_ses_alpha_assistant_1",
        name: "Title ses_nested",
        parentToolCallId: "call_ses_nested",
        parentMessageId: "prt_ses_alpha_assistant_1",
        parentSubagentRunId: "prt_ses_root_assistant_1",
      },
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "prt_ses_alpha_assistant_1",
      },
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "prt_ses_root_assistant_1",
      },
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "prt_ses_root_assistant_2",
        name: "Title ses_beta",
        parentToolCallId: "call_ses_beta",
        parentMessageId: "prt_ses_root_assistant_2",
      },
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "prt_ses_root_assistant_2",
      },
    ]);
  });

  test("reopens active text, reasoning, and tool streams with their own invocation IDs", () => {
    const tree = branchingTree(false);
    tree.get("ses_nested")!.history[1] = message("ses_nested", "assistant", [
      { type: "text", text: "Nested" },
      { type: "reasoning", text: "Thinking", time: { start: 1 } },
      {
        type: "tool",
        childSessionIds: [],
        tool: "Echo",
        callID: "call_echo",
        state: { status: "pending", input: {} },
      },
      { type: "text", text: "Already closed", time: { start: 1, end: 2 } },
    ]);
    const result = projectTree("ses_root", tree);
    expect(result.lifecycle.map((event) => event.type)).toEqual([
      EventType.SUBAGENT_STARTED,
      EventType.SUBAGENT_STARTED,
      EventType.SUBAGENT_STARTED,
    ]);
    expect(
      result.open.map((event) => [event.type, event.subagentRunId]),
    ).toEqual([
      [EventType.TEXT_MESSAGE_START, undefined],
      [EventType.TEXT_MESSAGE_START, "prt_ses_root_assistant_1"],
      [EventType.TEXT_MESSAGE_START, "prt_ses_alpha_assistant_1"],
      [EventType.REASONING_START, "prt_ses_alpha_assistant_1"],
      [EventType.REASONING_MESSAGE_START, "prt_ses_alpha_assistant_1"],
      [EventType.TOOL_CALL_START, "prt_ses_alpha_assistant_1"],
      [EventType.TEXT_MESSAGE_START, "prt_ses_root_assistant_2"],
    ]);
    expect(result.open[5]).toMatchObject({
      toolCallId: "call_echo",
      parentMessageId: "prt_ses_nested_assistant_2",
    });
  });

  test.each([
    {
      name: "unfinished despite a completed child step",
      state: { status: "running", input: {}, time: { start: 1 } },
      terminal: [],
    },
    {
      name: "completed",
      state: {
        status: "completed",
        input: {},
        output: { type: "text", value: "Done" },
        title: "Done",
        metadata: {},
        time: { start: 1, end: 2 },
      },
      terminal: [{ type: EventType.SUBAGENT_FINISHED }],
    },
    {
      name: "interrupted",
      state: {
        status: "error",
        input: {},
        error: "Cancelled",
        time: { start: 1, end: 2 },
      },
      terminal: [{ type: EventType.SUBAGENT_ERROR, message: "Cancelled" }],
    },
  ])("derives $name lifecycle from the parent tool", ({ state, terminal }) => {
    const tree = new Map([
      [
        "ses_root",
        transcript("ses_root", [
          message("ses_root", "assistant", [{ ...proxy("ses_child"), state }]),
        ]),
      ],
      [
        "ses_child",
        transcript(
          "ses_child",
          [
            message("ses_child", "assistant", [], {
              time: { created: 1, completed: 2 },
              finish: "tool-calls",
            }),
          ],
          "ses_root",
        ),
      ],
    ]);
    const result = projectTree("ses_root", tree);
    expect(result.lifecycle[0]?.type).toBe(EventType.SUBAGENT_STARTED);
    expect(result.lifecycle.slice(1)).toEqual(
      terminal.map((event) => ({
        ...event,
        subagentRunId: "prt_ses_root_assistant_0",
      })),
    );
  });

  test("starts a linked child before its first Assistant exists", () => {
    const tree = new Map([
      [
        "ses_root",
        transcript("ses_root", [
          message("ses_root", "assistant", [proxy("ses_child")]),
        ]),
      ],
      [
        "ses_child",
        transcript(
          "ses_child",
          [
            message("ses_child", "user", [
              { type: "text", text: "Private input" },
            ]),
          ],
          "ses_root",
        ),
      ],
    ]);
    const result = projectTree("ses_root", tree);
    expect(result.lifecycle.map((event) => event.type)).toEqual([
      EventType.SUBAGENT_STARTED,
    ]);
    expect(
      result.messages.some((item) => item.subagentRunId !== undefined),
    ).toBe(false);
    expect(Object.keys(result.messageInfo)).toEqual(["msg_ses_root_assistant"]);
  });

  test("shows a delegate input when that Session itself is the observed root", () => {
    const result = projectTree("ses_alpha", branchingTree());
    expect(result.messages[0]).toMatchObject({
      id: "msg_ses_alpha_user",
      role: "user",
    });
    expect(result.messages[0]).not.toHaveProperty("subagentRunId");
    expect(result.lifecycle).toHaveLength(1);
    expect(result.lifecycle[0]).toMatchObject({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "prt_ses_alpha_assistant_1",
    });
    expect(result.lifecycle[0]).not.toHaveProperty("parentSubagentRunId");
  });

  test("does not mutate its input or accumulate results across repeated projections", () => {
    const tree = branchingTree();
    const original = structuredClone(tree);
    const first = projectTree("ses_root", tree);
    const second = projectTree("ses_root", tree);
    expect(tree).toEqual(original);
    expect(second).toEqual(first);
    expect(second.messages).not.toBe(first.messages);
    expect(second.messageInfo).not.toBe(first.messageInfo);
    expect(second.lifecycle).not.toBe(first.lifecycle);
    expect(second.open).not.toBe(first.open);
  });

  test.each(["ses_root", "ses_nested"])(
    "rejects a missing transcript: %s",
    (id) => {
      const tree = branchingTree();
      tree.delete(id);
      expect(() => projectTree("ses_root", tree)).toThrow(
        "Delegate transcript must be loaded",
      );
    },
  );
});

test.each(["chat", "dig_in", "delegate", "scheduled"] as const)(
  "projects the supplied visible page identically for %s",
  (kind) => {
    const tree = branchingTree();
    const expected = projectTree("ses_root", tree);
    tree.get("ses_root")!.session.kind = kind;
    expect(projectTree("ses_root", tree)).toEqual(expected);
  },
);
