// Purpose: Verifies application composition connects committed SQL changes to Resource invalidations through shared Events.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { ResourceChanged } from "@openchart/server/lib/resource/events";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Permission } from "@openchart/server/agent/permission";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import { EventType } from "@ag-ui/core";
import { create as createSession } from "@openchart/server/agent/session/operations/create";
import { sql } from "drizzle-orm";
import { Effect, Exit, Fiber, Option, Schema, Scope, Stream } from "effect";
import { expect, test, vi } from "vitest";

import { makeRuntime } from "./runtime";
import { router } from "./index";

test("shares pending permissions and the profile registry across application calls", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const scope = await Effect.runPromise(Scope.make());
  try {
    const profiles = await runtime.runPromise(AgentProfile.Service);
    await runtime.runPromise(
      profiles
        .transform((draft) => {
          draft.update("analyst", (info) => {
            info.permission.push({
              action: "read",
              resource: "*",
              decision: "ask",
            });
          });
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const session = await runtime.runPromise(createSession());
    const first = await runtime.runPromise(Permission.Service);
    const asked = await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* Events.Service;
        const live = yield* events
          .allBounded(256)
          .pipe(Effect.provideService(Scope.Scope, scope));
        return yield* live.pipe(
          Stream.filter(
            (event): event is typeof AgentEvent.Type =>
              event.type === AgentEvent.type,
          ),
          Stream.filter(
            (event) =>
              event.data.event.type === EventType.STATE_DELTA &&
              event.data.event.delta.some(
                (patch) => patch.path === "/permissions",
              ),
          ),
          Stream.runHead,
          Effect.forkIn(scope),
        );
      }),
    );
    let completed = false;
    const waiter = await runtime.runPromise(
      first
        .ask({
          sessionID: session.id,
          action: "read",
          resources: ["/notes/a"],
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkIn(scope),
        ),
    );
    const notification = Option.getOrThrow(
      await runtime.runPromise(Fiber.join(asked)),
    ).data.event;
    expect(notification.type).toBe(EventType.STATE_DELTA);
    if (notification.type !== EventType.STATE_DELTA)
      throw new Error("Missing permission state");
    const request = Schema.decodeUnknownSync(Schema.Array(Permission.Request))(
      notification.delta.find((patch) => patch.path === "/permissions")?.value,
    )[0]!;
    const second = await runtime.runPromise(Permission.Service);
    expect(first).toBe(second);
    expect(completed).toBe(false);
    expect(await runtime.runPromise(second.list())).toEqual([request]);
    await runtime.runPromise(
      second.reply({ requestID: request.id, reply: "once" }),
    );
    await runtime.runPromise(Fiber.join(waiter));
    expect(completed).toBe(true);
    expect(await runtime.runPromise(first.list())).toEqual([]);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  }
});

test("owns one built-in profile registry for the application runtime", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  try {
    const first = await runtime.runPromise(AgentProfile.Service);
    const second = await runtime.runPromise(AgentProfile.Service);
    expect(first).toBe(second);
    expect(await runtime.runPromise(first.resolve("title"))).toMatchObject({
      name: "title",
      hidden: true,
    });
    expect((await runtime.runPromise(first.resolve()))?.name).toBe("analyst");
  } finally {
    await runtime.dispose();
  }
});

test("publishes a committed cascade batch through the shared Events service", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  try {
    const caller = router.createCaller({ runtime });
    const schedule = await caller.resources.agent_schedule.create({
      name: "Example",
      target: {
        kind: "agent_prompt",
        prompt: {
          agent: "analyst",
          model: { providerID: "codex", modelID: "tier1" },
          parts: [{ type: "text", text: "Research" }],
        },
      },
      recurrence: { kind: "once", fireAt: "2090-01-01T00:00:00.000Z" },
    });
    const { db } = await runtime.runPromise(Database.Service);
    await runtime.runPromise(
      db.transaction((tx) =>
        tx.run(sql`
      INSERT INTO agent_schedule_occurrence (id, schedule_id, fire_at, revision)
      VALUES ('aso_one', ${schedule.id}, 1, 3)
    `),
      ),
    );
    const events = await runtime.runPromise(Events.Service);
    const publish = vi.spyOn(events, "publish");

    await caller.resources.agent_schedule.delete({ id: schedule.id });

    expect(
      publish.mock.calls.map(([definition, data]) => {
        expect(definition).toBe(ResourceChanged);
        return data;
      }),
    ).toEqual([
      { resource: "agent_schedule", id: schedule.id, revision: 1 },
      { resource: "agent_schedule_occurrence", id: "aso_one", revision: 3 },
    ]);
  } finally {
    vi.restoreAllMocks();
    await runtime.dispose();
  }
});
