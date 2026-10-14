// Purpose: Verifies restart repair and automatic scheduled execution through the real runtime, HTTP Resource API, and Agent engine.

import type { AgentPromptTarget } from "@openchart/server/agent/contracts/agent-prompt-target";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AvailableModel } from "@openchart/models/model-provider";
import { mockModels } from "@openchart/server/models/models.test-utils";
import { createRequestHandler, type AppRouter } from "@openchart/server";
import { makeRuntime } from "@openchart/server/runtime";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Session } from "@openchart/server/agent/session";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Transactor } from "@openchart/server/lib/resource";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { createTRPCClient, httpLink } from "@trpc/client";
import { Effect, Layer } from "effect";
import { simulateReadableStream } from "ai";
import { expect, test, vi } from "vitest";

test("repairs a durable queued fire after runtime restart and completes it through Prompt", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "openchart-scheduler-"));
  const databasePath = path.join(directory, "openchart.sqlite3");
  const model = AvailableModel.parse({
    kind: "language",
    providerID: "openai",
    id: "test-model",
    name: "Test",
    tier: 1,
    capabilities: {
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
    limit: { context: 200_000, output: 16_384 },
  });
  const finish: LanguageModelV4StreamPart = {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 6, text: 6, reasoning: 0 },
    },
  };
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "SCHEDULE_OK" },
        { type: "text-end", id: "answer" },
        finish,
      ],
    }),
  }));
  const language: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: model.providerID,
    modelId: model.id,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream,
  };
  mockModels(model, language);
  let server: ReturnType<typeof createHttpServer> | undefined;
  let runtime: ReturnType<typeof makeRuntime> | undefined;
  try {
    // Persist admission without wake/occurrence, then close this connection.
    // The next runtime has no in-memory knowledge of the interrupted dispatch.
    const setup = AgentRunStore.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databasePath, () => Effect.void),
          Events.layer,
          Session.layer,
          Layer.succeed(Publisher.Service, { publish: () => Effect.void }),
        ),
      ),
    );
    const { schedule, accepted } = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service;
        const runs = yield* AgentRunStore.Service;
        const schedule = yield* Transactor.run(
          agentScheduleResource.transitions.create({
            name: "Scheduled research",
            enabled: true,
            nextFireAt: 0,
            recurrence: { kind: "once", fireAt: "1970-01-01T00:00:00.000Z" },
            target: {
              kind: "agent_prompt",
              prompt: {
                agent: "analyst",
                model: {
                  providerID: "codex" as const,
                  modelID: "tier1" as const,
                },
                parts: [{ type: "text", text: "Give the scheduled response." }],
              },
            },
          }),
        );
        const session = yield* sessions.create({ title: schedule.name });
        const accepted = yield* runs.enqueue({
          sessionID: session.id,
          sessionIntentID: `schedule:${schedule.id}:0`,
          input: (schedule.target as AgentPromptTarget).prompt,
        });
        return { schedule, accepted };
      }).pipe(Effect.provide(setup)),
    );

    runtime = makeRuntime({ home: directory });
    await runtime.context();
    server = createHttpServer(createRequestHandler(runtime));
    // Execution starts at runtime initialization, before the first HTTP request.
    await vi.waitFor(() => expect(doStream).toHaveBeenCalledTimes(1));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP listener");
    const client = createTRPCClient<AppRouter>({
      links: [httpLink({ url: `http://127.0.0.1:${address.port}/trpc` })],
    });
    const fires = await client.resources.agent_schedule_occurrence.list.query({
      filter: { scheduleId: schedule.id },
    });
    expect(fires.items).toHaveLength(1);
    expect(fires.items[0]).toMatchObject({
      agentRunId: accepted.id,
      sessionId: accepted.sessionID,
      fireAt: 0,
    });
    const snapshot = await vi.waitFor(async () => {
      const snapshot = await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* AgentRunStore.Service;
          const sessions = yield* Session.Service;
          return {
            run: yield* runs.getByIntent(accepted.sessionIntentID),
            transcript: yield* sessions.readTranscriptPage({
              sessionID: accepted.sessionID,
              turnLimit: Number.MAX_SAFE_INTEGER,
            }),
            allRuns: yield* runs.list(accepted.sessionID),
          };
        }).pipe(Effect.provide(setup)),
      );
      expect(snapshot.run?.status).toBe("completed");
      return snapshot;
    });
    expect(snapshot.allRuns).toHaveLength(1);
    expect(snapshot.run?.id).toBe(accepted.id);
    expect(JSON.stringify(snapshot.transcript.history)).toContain(
      "SCHEDULE_OK",
    );
    expect(
      await client.resources.agent_schedule.get.query({ id: schedule.id }),
    ).toEqual(schedule);

    const manual = await client.resources.agent_schedule.create.mutate({
      name: "Manual research",
      enabled: false,
      recurrence: { kind: "cron", expression: "0 8 * * *", timeZone: "UTC" },
      target: schedule.target,
    });
    await expect(
      client.scheduler.runNow.mutate({ id: manual.id, enabled: true } as never),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    await expect(
      client.scheduler.runNow.mutate({ id: "ags_missing" }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    const occurrence = await client.scheduler.runNow.mutate({ id: manual.id });
    expect(occurrence.scheduleId).toBe(manual.id);
    expect(occurrence.sessionId).not.toBe(accepted.sessionID);
    expect(
      await client.resources.agent_schedule.get.query({ id: manual.id }),
    ).toEqual(manual);
    expect(
      (
        await client.resources.agent_schedule_occurrence.list.query({
          filter: { scheduleId: manual.id },
        })
      ).items,
    ).toEqual([occurrence]);
    await vi.waitFor(async () => {
      const completed = await runtime!.runPromise(
        Effect.gen(function* () {
          const runs = yield* AgentRunStore.Service;
          const sessions = yield* Session.Service;
          return {
            runs: yield* runs.list(occurrence.sessionId!),
            transcript: yield* sessions.readTranscriptPage({
              sessionID: occurrence.sessionId!,
              turnLimit: Number.MAX_SAFE_INTEGER,
            }),
          };
        }),
      );
      expect(completed.runs).toHaveLength(1);
      expect(completed.runs[0]?.status).toBe("completed");
      expect(JSON.stringify(completed.transcript.history)).toContain(
        "SCHEDULE_OK",
      );
    });
    expect(doStream).toHaveBeenCalledTimes(2);
  } finally {
    if (server) {
      const closing = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closing;
    }
    await runtime?.dispose();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});
