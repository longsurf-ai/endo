// Purpose: Preserve read positions across new results, stale acknowledgements and failed writes.
import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import {
  Publisher,
  type Change,
} from "@openchart/server/agent/publisher/publisher";
import { ID as RunId } from "@openchart/server/agent/run/run";
import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { agentRun } from "@openchart/server/agent/schema";
import { create } from "./create";
import { get } from "./get";
import { list } from "./list";
import { markRead } from "./mark-read";

test("read marks acknowledge only observed ended Runs and never change ordering", async () => {
  const published: Change[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      const session = yield* create();
      const other = yield* create();
      const first = RunId.create();
      const second = RunId.create();
      const third = RunId.create();
      const otherRun = RunId.create();
      const input: AgentPromptInput = {
        agent: "analyst",
        model: { providerID: "codex", modelID: "tier1" },
        parts: [{ type: "text", text: "Hello" }],
      };
      yield* db.insert(agentRun).values([
        {
          id: first,
          sessionId: session.id,
          sessionIntentId: first,
          input,
          status: "completed",
          createdAt: 1,
          startedAt: 1,
          finishedAt: 2,
        },
        {
          id: second,
          sessionId: session.id,
          sessionIntentId: second,
          input,
          status: "completed",
          createdAt: 3,
          startedAt: 3,
          finishedAt: 4,
        },
        {
          id: third,
          sessionId: session.id,
          sessionIntentId: third,
          input,
          status: "running",
          createdAt: 5,
          startedAt: 5,
        },
        {
          id: otherRun,
          sessionId: other.id,
          sessionIntentId: otherRun,
          input,
          status: "failed",
          createdAt: 5,
          startedAt: 5,
          finishedAt: 6,
        },
      ]);
      published.length = 0;
      expect(
        (yield* list({ limit: 10 })).items.find(({ id }) => id === session.id),
      ).toMatchObject({ isUnread: true, isActive: true });
      yield* markRead({ runId: first });
      // The second result arrived before the first result's acknowledgement.
      expect(
        (yield* list({ limit: 10 })).items.find(({ id }) => id === session.id)
          ?.isUnread,
      ).toBe(true);
      yield* markRead({ runId: second });
      expect(yield* get(session.id)).toEqual({
        ...session,
        lastReadRunId: second,
      });
      expect(published).toHaveLength(2);
      expect(published[1]).toMatchObject({
        type: "session.updated",
        session: { lastReadRunId: second },
      });
      yield* markRead({ runId: first });
      yield* markRead({ runId: second });
      expect(published).toHaveLength(2);
      expect(
        (yield* list({ limit: 10 })).items.find(({ id }) => id === session.id)
          ?.isUnread,
      ).toBe(false);
      for (const runId of [third, RunId.create()]) {
        const error = yield* markRead({ runId }).pipe(Effect.flip);
        expect(error._tag).toBe("Session.ReadRunUnavailable");
      }
      expect(published).toHaveLength(2);
      yield* db
        .update(agentRun)
        .set({ status: "failed", finishedAt: 7 })
        .where(eq(agentRun.id, third));
      expect(
        (yield* list({ limit: 10 })).items.find(({ id }) => id === session.id),
      ).toMatchObject({ isUnread: true, isActive: false });
      yield* markRead({ runId: third });
      expect(yield* get(session.id)).toEqual({
        ...session,
        lastReadRunId: third,
      });
      expect(yield* get(other.id)).toEqual(other);
      yield* markRead({ runId: otherRun });
      expect(yield* get(other.id)).toEqual({
        ...other,
        lastReadRunId: otherRun,
      });
      expect(yield* get(session.id)).toEqual({
        ...session,
        lastReadRunId: third,
      });
      expect(published.at(-1)).toMatchObject({
        type: "session.updated",
        session: { id: other.id, lastReadRunId: otherRun },
      });
    }).pipe(
      Effect.provideService(Publisher.Service, {
        publish: (change) =>
          Effect.sync(() => {
            published.push(change);
          }),
      }),
      Effect.provide(
        Layer.mergeAll(
          Database.layer(":memory:", () => Effect.void),
          Events.layer,
        ),
      ),
    ),
  );
});
