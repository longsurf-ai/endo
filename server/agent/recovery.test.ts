// Purpose: Verifies retryable startup repair, preserved history, and automatic queue recovery after restart.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  Assistant,
  User,
} from "@openchart/server/agent/contracts/message";
import type { Part } from "@openchart/server/agent/contracts/part";
import { AvailableModel } from "@openchart/models/model-provider";
import { mockModels } from "@openchart/server/models/models.test-utils";
import { Database } from "@openchart/server/db";
import { makeRuntime } from "@openchart/server/runtime";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { Session } from "@openchart/server/agent/session";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Events } from "@openchart/server/events";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { simulateReadableStream } from "ai";
import { afterEach, expect, test, vi } from "vitest";
import { agentMessages, agentParts, agentRun, agentSessions } from "./schema";
import { interruptAndRecover } from "./recovery";

const model = { providerID: "codex" as const, modelID: "tier1" as const };
const prompt = (text: string) => ({
  agent: "analyst",
  model,
  parts: [{ type: "text" as const, text }],
});
const user: User = {
  id: "msg_0001",
  sessionID: "ses_root",
  role: "user",
  time: { created: 10 },
  agent: "analyst",
  model,
};
const assistant: Assistant = {
  id: "msg_0002",
  sessionID: user.sessionID,
  role: "assistant",
  time: { created: 20 },
  triggeringUserMessageID: user.id,
  ...model,
  agent: "analyst",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const parts: Part[] = [
  {
    id: "prt_text",
    messageID: assistant.id,
    type: "text",
    text: "Partial  ",
    time: { start: 20 },
  },
  {
    id: "prt_reasoning",
    messageID: assistant.id,
    type: "reasoning",
    text: "Thinking",
    time: { start: 20 },
  },
  {
    id: "prt_untimed",
    messageID: assistant.id,
    type: "text",
    text: "Static context",
  },
  {
    id: "prt_pending",
    messageID: assistant.id,
    type: "tool",
    childSessionIds: [],
    callID: "pending",
    tool: "echo",
    state: {
      status: "pending",
      input: {},
      metadata: { progress: "preparing" },
    },
  },
  {
    id: "prt_running",
    messageID: assistant.id,
    type: "tool",
    callID: "running",
    tool: "workflow",
    childSessionIds: ["ses_child"],
    providerMetadata: { provider: { id: "native-call" } },
    state: {
      status: "running",
      input: { question: "Research" },
      time: { start: 21 },
      metadata: { preparedArgs: { question: "Research" } },
    },
  },
  {
    id: "prt_completed",
    messageID: assistant.id,
    type: "tool",
    childSessionIds: [],
    callID: "completed",
    tool: "echo",
    state: {
      status: "completed",
      input: {},
      output: { type: "json", value: { answer: 42 } },
      title: "Done",
      metadata: { saved: true },
      time: { start: 21, end: 22 },
    },
  },
  {
    id: "prt_error",
    messageID: assistant.id,
    type: "tool",
    childSessionIds: [],
    callID: "error",
    tool: "echo",
    state: {
      status: "error",
      input: {},
      error: "Existing failure",
      time: { start: 21, end: 22 },
    },
  },
];

const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service;
  return {
    sessions: yield* db.select().from(agentSessions).orderBy(agentSessions.id),
    runs: yield* db.select().from(agentRun).orderBy(agentRun.id),
    messages: yield* db.select().from(agentMessages).orderBy(agentMessages.id),
    parts: yield* db.select().from(agentParts).orderBy(agentParts.id),
  };
});

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service;
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.insert(agentSessions).values([
        { kind: "chat", id: "ses_root", title: "Existing chat" },
        {
          id: "ses_child",
          parentId: "ses_root",
          kind: "delegate",
          title: "Child",
        },
        { kind: "chat", id: "ses_other", title: "Another chat" },
        { kind: "chat", id: "ses_closed", title: "Completed chat" },
      ]);
      yield* tx.insert(agentRun).values([
        {
          id: "agr_running",
          sessionId: "ses_root",
          sessionIntentId: "interrupted",
          input: prompt("Never replay this"),
          status: "running",
          createdAt: 1,
          startedAt: 2,
        },
        {
          id: "agr_before_user",
          sessionId: "ses_other",
          sessionIntentId: "before-user",
          input: prompt("Interrupted before User creation"),
          status: "running",
          createdAt: 1,
          startedAt: 2,
        },
        {
          id: "agr_completed",
          sessionId: "ses_closed",
          sessionIntentId: "completed",
          input: prompt("Finished"),
          status: "completed",
          createdAt: 1,
          startedAt: 2,
          finishedAt: 3,
        },
        {
          id: "agr_failed",
          sessionId: "ses_closed",
          sessionIntentId: "failed",
          input: prompt("Failed"),
          status: "failed",
          createdAt: 4,
          startedAt: 5,
          finishedAt: 6,
        },
        {
          id: "agr_queued_1",
          sessionId: "ses_root",
          sessionIntentId: "queued-1",
          input: prompt("root first"),
          status: "queued",
          queuePosition: 0,
          createdAt: 7,
        },
        {
          id: "agr_queued_2",
          sessionId: "ses_root",
          sessionIntentId: "queued-2",
          input: prompt("root second"),
          status: "queued",
          queuePosition: 1,
          createdAt: 8,
        },
        {
          id: "agr_queued_other",
          sessionId: "ses_other",
          sessionIntentId: "queued-other",
          input: prompt("other first"),
          status: "queued",
          queuePosition: 0,
          createdAt: 7,
        },
      ]);
      yield* messageStore.insert(tx, {
        info: user,
        parts: [
          {
            id: "prt_user",
            messageID: user.id,
            type: "text",
            text: "Original question",
            time: { start: 10 },
          },
        ],
      });
      yield* messageStore.insert(tx, { info: assistant, parts });
      yield* messageStore.insert(tx, {
        info: { ...assistant, id: "msg_0003", sessionID: "ses_child" },
        parts: [
          {
            id: "prt_child",
            messageID: "msg_0003",
            type: "text",
            text: "Child partial",
            time: { start: 20 },
          },
        ],
      });
      // A failed cleanup may leave active Parts under an already terminal header.
      yield* messageStore.insert(tx, {
        info: {
          ...assistant,
          id: "msg_0004",
          sessionID: "ses_closed",
          finish: "stop",
          time: { created: 20, completed: 30 },
        },
        parts: [{ ...parts[3]!, id: "prt_orphan", messageID: "msg_0004" }],
      });
      yield* messageStore.insert(tx, {
        info: {
          ...assistant,
          id: "msg_0005",
          sessionID: "ses_child",
          agent: "compaction",
          error: { name: "UnknownError", data: { message: "Existing error" } },
        },
        parts: [],
      });
    }),
  );
});

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "openchart-recovery-"));
  directories.push(directory);
  const filename = path.join(directory, "openchart.sqlite3");
  const database = Database.layer(filename, () => Effect.void);
  const published: Publisher.Change[] = [];
  const woken: string[] = [];
  const services = AgentRunStore.layer.pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(Session.layer),
    Layer.provideMerge(
      Layer.succeed(SessionExecution.Service, {
        active: Effect.succeed(new Set<string>()),
        wake: (sessionID) =>
          Effect.sync(() => {
            woken.push(sessionID);
          }),
        interrupt: () => Effect.void,
      }),
    ),
    Layer.provide(Events.layer),
    Layer.provide(
      Layer.succeed(Publisher.Service, {
        publish: (change) =>
          Effect.sync(() => {
            published.push(structuredClone(change));
          }),
      }),
    ),
  );
  return { filename, database, services, published, woken };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("repairs abandoned roots and delegates, preserves durable facts, and is idempotent", async () => {
  const { database, services, published, woken } = fixture();
  const before = await Effect.runPromise(
    seed.pipe(Effect.andThen(snapshot), Effect.provide(database)),
  );
  const ended = 1_000;
  const repaired = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(ended);
      const session = yield* Session.Service;
      yield* session.interruptUnfinished();
      return yield* snapshot;
    }).pipe(
      Effect.provide(Session.layer),
      Effect.provide(TestClock.layer()),
      Effect.provide(database),
    ),
  );
  expect(repaired.runs).toEqual(before.runs);
  const runFinishedAt = 2_000;
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(runFinishedAt);
      return yield* interruptAndRecover();
    }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
  );
  expect([...woken].sort()).toEqual(["ses_other", "ses_root"]);
  const after = await Effect.runPromise(
    snapshot.pipe(Effect.provide(database)),
  );

  expect(after.messages).toEqual(repaired.messages);
  expect(after.parts).toEqual(repaired.parts);
  expect(after.sessions).toEqual(before.sessions);
  for (const row of before.runs) {
    const saved = after.runs.find((run) => run.id === row.id)!;
    expect(saved).toEqual(
      row.status === "running"
        ? { ...row, status: "failed", finishedAt: runFinishedAt }
        : row,
    );
  }
  for (const row of before.messages) {
    const saved = after.messages.find((message) => message.id === row.id)!;
    if (row.role === "user" || row.id === "msg_0004") {
      expect(saved).toEqual(row);
      continue;
    }
    expect(saved.data).toEqual({
      ...row.data,
      time: { ...row.data.time, completed: ended },
      error:
        row.id === "msg_0005"
          ? { name: "UnknownError", data: { message: "Existing error" } }
          : {
              name: "MessageAbortedError",
              data: { message: "Execution interrupted by server restart" },
            },
    });
    expect(saved.data).not.toHaveProperty("summary", true);
  }
  for (const row of before.parts) {
    const saved = after.parts.find((part) => part.id === row.id)!;
    if (
      ["prt_completed", "prt_error", "prt_user", "prt_untimed"].includes(row.id)
    ) {
      expect(saved).toEqual(row);
      continue;
    }
    if (row.data.type === "tool") {
      expect(saved.data).toEqual({
        ...row.data,
        state: {
          status: "error",
          input: row.data.state.input,
          metadata: row.data.state.metadata,
          error: "Execution interrupted by server restart",
          time: {
            start:
              row.data.state.status === "running"
                ? row.data.state.time.start
                : ended,
            end: ended,
          },
        },
      });
      continue;
    }
    expect(saved.data).toEqual({
      ...row.data,
      time: { start: 20, end: ended },
    });
  }
  const interrupted = before.runs.filter((run) => run.status === "running");
  expect(published).toHaveLength(interrupted.length);
  expect(
    published
      .map((change) => {
        expect(change).toMatchObject({
          type: "run.updated",
          operation: "fail",
          run: { status: "failed", finishedAt: runFinishedAt },
        });
        if (change.type !== "run.updated")
          throw new Error("Expected Run change");
        expect(change.runs).toContainEqual(change.run);
        return change.run.id;
      })
      .sort(),
  ).toEqual(interrupted.map((run) => run.id).sort());
  await Effect.runPromise(interruptAndRecover().pipe(Effect.provide(services)));
  expect(published).toHaveLength(interrupted.length);
  expect(
    await Effect.runPromise(snapshot.pipe(Effect.provide(database))),
  ).toEqual(after);
});

test.each(["transcript", "run"] as const)(
  "a failed %s repair blocks startup and can retry without undoing committed repairs",
  async (failure) => {
    const { filename, database, services, published, woken } = fixture();
    const before = await Effect.runPromise(
      seed.pipe(Effect.andThen(snapshot), Effect.provide(database)),
    );
    await Effect.runPromise(
      Database.Service.use(({ db }) =>
        db.run(
          sql.raw(`
          CREATE TRIGGER reject_recovery BEFORE UPDATE ON ${failure === "transcript" ? "agent_messages" : "agent_run"}
          ${failure === "run" ? "WHEN (SELECT COUNT(*) FROM agent_run WHERE status = 'running') = 1" : ""}
          BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END
        `),
        ),
      ).pipe(Effect.provide(database)),
    );
    const runtime = makeRuntime({
      home: path.dirname(filename),
    });
    try {
      await expect(runtime.context()).rejects.toThrow();
    } finally {
      await runtime.dispose();
    }
    const failed = await Effect.runPromise(
      snapshot.pipe(Effect.provide(database)),
    );
    // Neither failure may claim queued work; completed Run repairs survive.
    for (const run of before.runs.filter((run) => run.status !== "running")) {
      expect(failed.runs.find((row) => row.id === run.id)).toEqual(run);
    }
    expect(failed.sessions).toEqual(before.sessions);
    if (failure === "transcript") {
      // A header failure rolls back Part repair in the Message-owned transaction.
      expect(failed).toEqual(before);
    } else {
      const interrupted = before.runs.filter((run) => run.status === "running");
      expect(interrupted).toHaveLength(2);
      expect(
        failed.runs
          .filter((run) =>
            interrupted.some((previous) => previous.id === run.id),
          )
          .map((run) => run.status)
          .sort(),
      ).toEqual(["failed", "running"]);
      expect(failed.messages).not.toEqual(before.messages);
      expect(failed.parts).not.toEqual(before.parts);
    }
    await Effect.runPromise(
      Database.Service.use(({ db }) =>
        db.run(sql`DROP TRIGGER reject_recovery`),
      ).pipe(Effect.provide(database)),
    );
    await Effect.runPromise(
      interruptAndRecover().pipe(Effect.provide(services)),
    );
    expect([...woken].sort()).toEqual(["ses_other", "ses_root"]);
    const retried = await Effect.runPromise(
      snapshot.pipe(Effect.provide(database)),
    );
    if (failure === "run") {
      expect(retried.messages).toEqual(failed.messages);
      expect(retried.parts).toEqual(failed.parts);
    }
    for (const run of failed.runs) {
      expect(retried.runs.find((row) => row.id === run.id)).toEqual(
        run.status === "running"
          ? { ...run, status: "failed", finishedAt: expect.any(Number) }
          : run,
      );
    }
    const remaining = failed.runs.filter((run) => run.status === "running");
    expect(published).toHaveLength(remaining.length);
    await Effect.runPromise(
      interruptAndRecover().pipe(Effect.provide(services)),
    );
    expect(published).toHaveLength(remaining.length);
    expect(
      await Effect.runPromise(snapshot.pipe(Effect.provide(database))),
    ).toEqual(retried);
  },
);

test("runtime startup repairs first and drains every persisted queue without replaying interrupted Runs", async () => {
  const { filename, database } = fixture();
  await Effect.runPromise(seed.pipe(Effect.provide(database)));
  const available = AvailableModel.parse({
    kind: "language",
    providerID: model.providerID,
    id: model.modelID,
    name: "Recovery test",
    tier: 1,
    capabilities: {
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
    limit: { context: 200_000, output: 16_384 },
  });
  const calls: string[] = [];
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async (options) => {
    const lastUser = options.prompt
      .filter((message) => message.role === "user")
      .at(-1)!;
    calls.push(JSON.stringify(lastUser.content));
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "RECOVERED" },
          { type: "text-end", id: "answer" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 12,
                noCache: 12,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 6, text: 6, reasoning: 0 },
            },
          },
        ],
      }),
    };
  });
  const language: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: model.providerID,
    modelId: model.modelID,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream,
  };
  mockModels(available, language);
  const runtime = makeRuntime({
    home: path.dirname(filename),
  });
  try {
    // Startup alone resumes both Sessions; no submission or HTTP request wakes them.
    await runtime.context();
    await vi.waitFor(async () => {
      const rows = await runtime.runPromise(snapshot);
      expect(
        rows.runs
          .filter((run) => run.id.startsWith("agr_queued"))
          .map((run) => run.status),
      ).toEqual(["completed", "completed", "completed"]);
    });
    expect(calls).toHaveLength(3);
    expect(calls.findIndex((call) => call.includes("root first"))).toBeLessThan(
      calls.findIndex((call) => call.includes("root second")),
    );
    expect(calls.some((call) => call.includes("other first"))).toBe(true);
    const rows = await runtime.runPromise(snapshot);
    expect(rows.runs).toHaveLength(7);
    expect(rows.runs.find((run) => run.id === "agr_running")?.status).toBe(
      "failed",
    );
    expect(rows.runs.find((run) => run.id === "agr_before_user")?.status).toBe(
      "failed",
    );
    const transcript = await runtime.runPromise(
      Session.Service.use((sessions) =>
        sessions.readTranscriptPage({
          sessionID: "ses_root",
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ),
    );
    expect(JSON.stringify(transcript)).toContain("RECOVERED");
    // A retry of the old intent returns its failed Run, never a new execution.
    const replay = await runtime.runPromise(
      AgentRunStore.Service.use((runs) =>
        runs.enqueue({
          sessionID: "ses_root",
          sessionIntentID: "interrupted",
          input: prompt("Never replay this"),
        }),
      ),
    );
    expect(replay).toMatchObject({ id: "agr_running", status: "failed" });
  } finally {
    await runtime.dispose();
  }
});
