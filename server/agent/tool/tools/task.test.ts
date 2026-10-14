// Purpose: Verifies Task's profile selection, permission boundary, and link-before-execution contract.

import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Tool } from "@openchart/server/agent/tool/tool";
import { Workflow } from "@openchart/server/agent/workflow";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { TaskTool } from "./task";

const input = {
  agent: "target",
  description: "Research",
  prompt: "Complete context",
};
const parentModel = {
  providerID: "codex" as const,
  modelID: "tier1" as const,
  selectedVariant: "low",
};

function fixture(profile: AgentProfile.Override = {}) {
  const calls: string[] = [];
  const prompts: AgentPromptInput[] = [];
  const context: Tool.Context = {
    rootRunID: "agr_test",
    sessionID: "ses_parent",
    messageID: "msg_parent",
    callID: "call_task",
    agent: "analyst",
    messages: [],
    ask: (request) =>
      Effect.sync(() => {
        expect(request).toEqual({
          permission: "task",
          patterns: ["target"],
          always: ["target"],
          metadata: { agent: "target", description: "Research" },
        });
        calls.push("permission");
      }),
    metadata: (progress) =>
      Effect.sync(() => {
        expect(progress).toEqual({
          title: "Research",
          childSessionIds: ["ses_child"],
        });
        calls.push("link");
      }),
  };
  const host = Workflow.Service.of({
    getResource: () => Effect.die("Unexpected Resource read"),
    parentPrompt: { agent: "analyst", model: parentModel, parts: [] },
    settings: { concurrency: 5 },
    agent: (prompt, onSession, options) =>
      Effect.gen(function* () {
        expect(options).toEqual({ title: "Research" });
        prompts.push(prompt);
        calls.push("create");
        yield* onSession("ses_child");
        calls.push("execute");
        return { sessionId: "ses_child", output: "Final answer" };
      }),
  });
  const execute = (
    args: unknown = input,
    overrides: Partial<Tool.Context> = {},
  ) =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* TaskTool);
      return yield* tool.execute(args, { ...context, ...overrides });
    }).pipe(
      Effect.provide(
        AgentProfile.layer({
          agents: { target: { prompt: "Target instructions", ...profile } },
        }),
      ),
      Effect.provideService(Workflow.Service, host),
    );
  return { execute, calls, prompts, context };
}

test.each(["primary", "subagent", "all"] as const)(
  "calls an explicit hidden %s profile with its own model",
  async (mode) => {
    const model = {
      providerID: "claude-code" as const,
      modelID: "tier3" as const,
    };
    const f = fixture({ mode, hidden: true, model, selectedVariant: "high" });
    expect(await Effect.runPromise(f.execute())).toEqual({
      title: "Research",
      metadata: {},
      output: { type: "text", value: "Final answer" },
    });
    expect(f.calls).toEqual(["permission", "create", "link", "execute"]);
    expect(f.prompts).toEqual([
      {
        agent: "target",
        model: { ...model, selectedVariant: "high" },
        parts: [{ type: "text", text: input.prompt }],
      },
    ]);
  },
);

test.each([
  { profile: {}, expected: parentModel },
  {
    profile: { selectedVariant: "high" },
    expected: { ...parentModel, selectedVariant: "high" },
  },
  {
    profile: {
      model: { providerID: "claude-code" as const, modelID: "tier2" as const },
    },
    expected: {
      providerID: "claude-code" as const,
      modelID: "tier2" as const,
      selectedVariant: undefined,
    },
  },
])(
  "falls back to the parent model without carrying variants across explicit models",
  async ({ profile, expected }) => {
    const f = fixture(profile);
    await Effect.runPromise(f.execute());
    expect(f.prompts[0]?.model).toEqual(expected);
  },
);

test("unknown profiles and rejected permission never create a child", async () => {
  const f = fixture();
  const error = await Effect.runPromise(
    f.execute({ ...input, agent: "missing" }).pipe(Effect.flip),
  );
  expect(error).toMatchObject({
    _tag: "Tool.TaskAgentNotFound",
    agent: "missing",
  });
  expect(f.calls).toEqual([]);
  const refusal = new Error("Permission rejected");
  expect(
    await Effect.runPromise(
      f.execute(input, { ask: () => Effect.fail(refusal) }).pipe(Effect.flip),
    ),
  ).toBe(refusal);
  expect(f.calls).toEqual([]);
});

test("a failed link never starts child execution", async () => {
  const f = fixture();
  const failure = new Error("Cannot commit child link");
  expect(
    await Effect.runPromise(
      f
        .execute(input, { metadata: () => Effect.fail(failure) })
        .pipe(Effect.flip),
    ),
  ).toBe(failure);
  expect(f.calls).toEqual(["permission", "create"]);
});

test.each([
  { ...input, prompt: " " },
  { ...input, sessionId: "ses_old" },
  { ...input, background: true },
])("rejects unsupported or empty input before side effects", async (args) => {
  const f = fixture();
  expect(
    await Effect.runPromise(f.execute(args).pipe(Effect.flip)),
  ).toMatchObject({ _tag: "Tool.InvalidArgumentsError" });
  expect(f.calls).toEqual([]);
});
