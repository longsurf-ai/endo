// Purpose: Verifies command Part construction, wire transport and separation from prompt admission.
import type {
  AgentPromptInput,
  AgentPromptPartInput,
} from "@openchart/server/agent/contracts/agent-prompt-input";
import { agentRun, agentSessions } from "@openchart/server/agent/schema";
import { Database } from "@openchart/server/db";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { router } from "@openchart/server";
import { makeRuntime } from "@openchart/server/runtime";
import { createTRPCClient, httpLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { BuildCommandRequest, buildCommand, restoreCommand } from "./command";
import { definitions } from "./catalog";

const request: typeof BuildCommandRequest.Type = {
  command: "best-of-n",
  arguments: "4 Research Google and its competitors",
};
const expected = [
  {
    type: "workflow",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: { n: 4, question: "Research Google and its competitors" },
  },
];

test("builds count and rest into Parts without Session or execution services", async () => {
  const before = structuredClone(request);
  expect(await Effect.runPromise(buildCommand(request))).toEqual(expected);
  expect(request).toEqual(before);
});

test.each(
  ["best-of-n", "multi-turn-debate"].flatMap((command) =>
    [
      "",
      "0 question",
      "-1 question",
      "1.5 question",
      "nope question",
      "Infinity question",
      "2",
    ].map((arguments_) => ({ command, arguments: arguments_ })),
  ),
)("rejects invalid $command arguments: $arguments", async (input) => {
  const result = await Effect.runPromise(
    buildCommand(input).pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "Command.InvalidInput" },
  });
});

test("compact builds a manual marker and rejects extra arguments", async () => {
  expect(
    await Effect.runPromise(
      buildCommand({ command: "compact", arguments: "" }),
    ),
  ).toEqual([{ type: "compaction", auto: false }]);
  expect(
    await Effect.runPromise(
      buildCommand({
        command: "compact",
        arguments: "Keep this text",
      }).pipe(Effect.result),
    ),
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "Command.InvalidInput" },
  });
});

test.each([
  { command: "thesis-killer", argument: "thesis" },
  { command: "hypothesis-race", argument: "question" },
])(
  "$command preserves a free-form request when building and restoring",
  async ({ command, argument }) => {
    const question = `  Research remote work over the next year\nCompare "focus time" with manager's outlook / risks  `;
    const request = { command, arguments: question };
    const parts = await Effect.runPromise(buildCommand(request));
    expect(parts).toEqual([
      {
        type: "workflow",
        workflow: `default:workflows/${command}.workflow.ts`,
        args: { [argument]: question },
      },
    ]);
    expect(await Effect.runPromise(restoreCommand(parts[0]!))).toEqual(request);
  },
);

test.each(
  ["thesis-killer", "hypothesis-race"].flatMap((command) =>
    ["", " ", "\n\t"].map((arguments_) => ({ command, arguments_ })),
  ),
)(
  "$command rejects a blank request: $arguments_",
  async ({ command, arguments_ }) => {
    expect(
      await Effect.runPromise(
        buildCommand({
          command,
          arguments: arguments_,
        }).pipe(Effect.result),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "Command.InvalidInput" },
    });
  },
);

test.each(
  definitions.flatMap(({ name }) =>
    (name === "compact"
      ? [""]
      : [
          "03  research\nGoogle /compact",
          '2 "  spaced  question  "',
          '2 "line one\nline two\tend"',
          `2 "Apple's" '"earnings"'`,
          `2 "'" '"'`,
          '2 "" "" question ""',
          '2 " "',
          "2 [Image 1] research 👀",
          '2 "C:\\workspace\\file"',
          "2 :file[report.tea]{name=/workspace/report.tea}",
          '2 "a\r\nb"',
        ]
    ).map((arguments_) => ({ command: name, arguments: arguments_ })),
  ),
)("round-trips registered command $command: $arguments", async (input) => {
  const parts = await Effect.runPromise(buildCommand(input));
  const before = structuredClone(parts);
  expect(parts).toHaveLength(1);
  const restored = await Effect.runPromise(restoreCommand(parts[0]!));
  expect(restored.command).toBe(input.command);
  expect(await Effect.runPromise(buildCommand(restored))).toEqual(parts);
  expect(parts).toEqual(before);
});

test.each<AgentPromptPartInput>([
  { type: "compaction", auto: true },
  { type: "compaction", auto: false, id: "prt_original" },
  { type: "text", text: "/compact" },
  { type: "workflow", workflow: "workspace:unknown.workflow.ts", args: {} },
  {
    type: "workflow",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: { n: 0, question: "bad count" },
  },
  {
    type: "workflow",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: { n: 2, question: "valid", extra: "must not disappear" },
  },
  {
    type: "workflow",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: { n: 2, question: `adjacent'"quotes` },
  },
  {
    type: "workflow",
    workflow: "default:workflows/multi-turn-debate.workflow.ts",
    args: { round: 2, topic: "" },
  },
])("rejects command Parts that cannot round-trip: %j", async (part) => {
  expect(
    await Effect.runPromise(restoreCommand(part).pipe(Effect.result)),
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "Command.UnsupportedPart" },
  });
});

test("tRPC builds wire-safe Parts without admission; prompt owns composition validation", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const client = createTRPCClient<typeof router>({
    links: [
      httpLink({
        url: "http://localhost/trpc",
        fetch: (input, init) =>
          fetchRequestHandler({
            endpoint: "/trpc",
            req: new Request(input, init),
            router,
            createContext: () => ({ runtime }),
          }),
      }),
    ],
  });
  try {
    expect(await client.agent.commands.query()).toEqual([
      {
        name: "compact",
        type: "compaction",
        description: expect.any(String),
        hints: [],
      },
      {
        name: "best-of-n",
        type: "workflow",
        description: expect.any(String),
        argumentHint:
          "Usage: <count> <question>. Count must be a positive integer. Example: 3 Research Google.",
        hints: ["$1", "$2"],
      },
      {
        name: "multi-turn-debate",
        type: "workflow",
        description: expect.any(String),
        argumentHint:
          "Usage: <round> <topic>. Round count must be a positive integer. Example: 3 Should public transit be free?",
        hints: ["$1", "$2"],
      },
      {
        name: "thesis-killer",
        type: "workflow",
        description: expect.any(String),
        argumentHint:
          "Usage: <thesis>. Example: Remote work improves team productivity over three years.",
        hints: ["$ARGUMENTS"],
      },
      {
        name: "hypothesis-race",
        type: "workflow",
        description: expect.any(String),
        argumentHint:
          "Usage: <question>. Example: Why did signups drop after the redesign?",
        hints: ["$ARGUMENTS"],
      },
    ]);
    const parts = await client.agent.buildCommand.mutate(request);
    expect(parts).toEqual(expected);
    const restored = await client.agent.restoreCommand.mutate(parts[0]!);
    expect(await client.agent.buildCommand.mutate(restored)).toEqual(parts);
    await expect(
      client.agent.restoreCommand.mutate({
        type: "workflow",
        workflow: "workspace:unknown.workflow.ts",
        args: {},
      }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    expect(
      await client.agent.buildCommand.mutate({
        command: "multi-turn-debate",
        arguments: '3 "Public transit" should be free',
      }),
    ).toEqual([
      {
        type: "workflow",
        workflow: "default:workflows/multi-turn-debate.workflow.ts",
        args: { round: 3, topic: "Public transit should be free" },
      },
    ]);
    const compact = await client.agent.buildCommand.mutate({
      command: "compact",
      arguments: "",
    });
    expect(compact).toEqual([{ type: "compaction", auto: false }]);
    await expect(
      client.agent.buildCommand.mutate({ ...request, command: "missing" }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(
      client.agent.buildCommand.mutate({ ...request, arguments: "0 question" }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    const submission = {
      ...request,
      sessionID: "ses_commands",
      sessionIntentID: "intent_command",
    };
    await expect(
      client.agent.buildCommand.mutate(submission),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    await runtime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        expect(yield* db.select().from(agentSessions)).toEqual([]);
        expect(yield* db.select().from(agentRun)).toEqual([]);
      }),
    );

    const session = await client.agent.createSession.mutate({});
    // The returned wire type can be composed directly into an ordinary prompt.
    const input: AgentPromptInput = {
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [...parts, ...parts],
    };
    await expect(
      client.agent.prompt.mutate({
        sessionID: session.id,
        sessionIntentID: "duplicate-workflow-parts",
        input,
      }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    await runtime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        expect(yield* db.select().from(agentRun)).toEqual([]);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
