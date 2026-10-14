// Purpose: Locks agent_run admission, FIFO claim, idempotency, and terminal transitions.

import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { agentRun, agentSessions } from "@openchart/server/agent/schema";
import { sql } from "drizzle-orm";
import { Effect, Exit, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { AgentRunStore } from "./store";

const prompt = Schema.decodeUnknownSync(AgentPromptInput)({
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text", text: "Analyze this." }],
});

function run<A, E>(
  effect: Effect.Effect<A, E, AgentRunStore.Service | Database.Service>,
) {
  const layer = AgentRunStore.layer.pipe(
    Layer.provideMerge(Database.layer(":memory:", () => Effect.void)),
    Layer.provide(Events.layer),
    Layer.provide(
      Layer.succeed(Publisher.Service, { publish: () => Effect.void }),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db
        .insert(agentSessions)
        .values({ kind: "chat", id: "session-1", title: "Test" });
      return yield* effect;
    }).pipe(Effect.provide(layer)),
  );
}

describe("AgentRunStore", () => {
  test.each([
    ["complete", "completed"],
    ["stop", "stop"],
    ["fail", "failed"],
  ] as const)(
    "only applies %s to running rows and preserves their terminal outcome",
    async (operation, status) => {
      await run(
        Effect.gen(function* () {
          const store = yield* AgentRunStore.Service;
          const admitted = yield* store.enqueue({
            sessionID: "session-1",
            sessionIntentID: "intent-1",
            input: prompt,
          });
          expect(
            Exit.isFailure(yield* Effect.exit(store[operation](admitted.id))),
          ).toBe(true);
          yield* store.claim("session-1");
          const finished = yield* store[operation](admitted.id);
          expect(finished.status).toBe(status);
          expect(finished.finishedAt).toEqual(expect.any(Number));
          for (const transition of [store.complete, store.stop, store.fail]) {
            expect(
              Exit.isFailure(yield* Effect.exit(transition(admitted.id))),
            ).toBe(true);
          }
          expect(yield* store.get(admitted.id)).toEqual(finished);
        }),
      );
    },
  );

  test("rejects orphan admission and preserves sessions with execution history", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const store = yield* AgentRunStore.Service;
        const rejected = yield* Effect.exit(
          store.enqueue({
            sessionID: "missing-session",
            sessionIntentID: "intent-1",
            input: prompt,
          }),
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(yield* db.select().from(agentRun)).toEqual([]);

        const admitted = yield* store.enqueue({
          sessionID: "session-1",
          sessionIntentID: "intent-1",
          input: prompt,
        });
        yield* store.claim("session-1");
        yield* store.complete(admitted.id);
        const deleted = yield* Effect.exit(
          db.run(sql`DELETE FROM agent_sessions WHERE id = 'session-1'`),
        );
        expect(Exit.isFailure(deleted)).toBe(true);
        expect((yield* store.get(admitted.id))?.status).toBe("completed");
        expect(yield* db.select().from(agentSessions)).toHaveLength(1);
      }),
    );
  });

  test("admits idempotently and claims one session in FIFO order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore.Service;
        const first = yield* store.enqueue({
          sessionID: "session-1",
          sessionIntentID: "intent-1",
          input: prompt,
        });
        expect(yield* store.getByIntent("intent-1")).toEqual(first);
        expect(yield* store.getByIntent("missing")).toBeUndefined();
        const replay = yield* store.enqueue({
          sessionID: "session-1",
          sessionIntentID: "intent-1",
          input: prompt,
        });
        const second = yield* store.enqueue({
          sessionID: "session-1",
          sessionIntentID: "intent-2",
          input: prompt,
        });

        const claimedFirst = yield* store.claim("session-1");
        if (!claimedFirst) return yield* Effect.die("first run not claimed");
        const completedFirst = yield* store.complete(claimedFirst.id);
        const claimedSecond = yield* store.claim("session-1");

        return {
          first,
          replay,
          second,
          claimedFirst,
          completedFirst,
          claimedSecond,
        };
      }),
    );

    expect(result.replay.id).toBe(result.first.id);
    expect(result.first.id).toMatch(/^agr_[0-9A-Za-z]{14}$/);
    expect(result.first.queuePosition).toBe(0);
    expect(result.second.queuePosition).toBe(1);
    expect(result.claimedFirst.id).toBe(result.first.id);
    expect(result.claimedFirst.status).toBe("running");
    expect(result.claimedFirst.queuePosition).toBeNull();
    expect(result.completedFirst.status).toBe("completed");
    expect(result.claimedSecond?.id).toBe(result.second.id);
  });

  test("does not claim another run while its session already runs", async () => {
    const claimed = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore.Service;
        yield* store.enqueue({
          sessionID: "session-1",
          sessionIntentID: "intent-1",
          input: prompt,
        });
        yield* store.enqueue({
          sessionID: "session-1",
          sessionIntentID: "intent-2",
          input: prompt,
        });
        yield* store.claim("session-1");
        return yield* store.claim("session-1");
      }),
    );

    expect(claimed).toBeUndefined();
  });
});
