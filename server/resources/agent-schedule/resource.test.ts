// Purpose: Verifies Schedule CRUD, cursor ownership, validation, revisions, and committed events.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { router } from "@openchart/server";
import { makeRuntime } from "@openchart/server/runtime";
import { Events } from "@openchart/server/events";
import { Transactor, Transition } from "@openchart/server/lib/resource";
import { ResourceChanged } from "@openchart/server/lib/resource/events";
import { ENVELOPE_FIELD_NAMES } from "@openchart/server/lib/resource/envelope";
import { Schema, Struct } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { agentScheduleResource } from "./resource";
import { agentScheduleStore } from "./store";

const input = {
  name: "Research",
  target: {
    kind: "agent_prompt" as const,
    prompt: {
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [{ type: "text" as const, text: "Research the watchlist." }],
    },
  },
  recurrence: { kind: "once" as const, fireAt: "2090-09-11T00:00:00.000Z" },
};
let runtime: ReturnType<typeof makeRuntime>;
let caller: ReturnType<typeof router.createCaller>;
beforeEach(() => {
  runtime = makeRuntime({ home: temporaryHome(), databasePath: ":memory:" });
  caller = router.createCaller({ runtime });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.dispose();
});

test("creates, reads, pages, patches, and deletes through the shared Resource API", async () => {
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  const created = await caller.resources.agent_schedule.create(input);
  expect(created).toMatchObject({
    ...input,
    revision: 1,
    enabled: true,
    nextFireAt: Date.parse(input.recurrence.fireAt),
  });
  expect(created).not.toHaveProperty("userId");
  expect(created).not.toHaveProperty("deletedAt");
  expect(created.id).toMatch(/^ags_/);
  expect(created.createdAt).toBe(created.updatedAt);
  expect(publish).toHaveBeenCalledExactlyOnceWith(ResourceChanged, {
    resource: "agent_schedule",
    id: created.id,
    revision: 1,
  });
  expect(await caller.resources.agent_schedule.get({ id: created.id })).toEqual(
    created,
  );
  expect(await caller.resources.agent_schedule.list()).toEqual({
    items: [created],
    nextCursor: null,
  });
  const renamed = await caller.resources.agent_schedule.patch({
    id: created.id,
    expectedRevision: 1,
    operations: [{ op: "replace", path: "/name", value: "Renamed" }],
  });
  expect(renamed).toMatchObject({
    name: "Renamed",
    revision: 2,
    nextFireAt: created.nextFireAt,
    createdAt: created.createdAt,
  });
  await expect(
    caller.resources.agent_schedule.patch({
      id: created.id,
      expectedRevision: 1,
      operations: [{ op: "replace", path: "/name", value: "Stale" }],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await caller.resources.agent_schedule.delete({ id: created.id });
  await expect(
    caller.resources.agent_schedule.get({ id: created.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await caller.resources.agent_schedule.list()).toEqual({
    items: [],
    nextCursor: null,
  });
});

test.each([
  ["providerID", "codxe"],
  ["providerID", "openai-compatible"],
  ["modelID", "tier6"],
  ["modelID", "gpt-6-astra"],
])(
  "rejects an invalid schedule model patch %s=%s without persisting it",
  async (field, value) => {
    const created = await caller.resources.agent_schedule.create(input);
    await expect(
      caller.resources.agent_schedule.patch({
        id: created.id,
        expectedRevision: created.revision,
        operations: [
          { op: "replace", path: `/target/prompt/model/${field}`, value },
        ],
      }),
    ).rejects.toThrow();
    expect(
      await caller.resources.agent_schedule.get({ id: created.id }),
    ).toEqual(created);
    expect(() =>
      Schema.decodeUnknownSync(agentScheduleResource.createSchema)({
        ...input,
        target: {
          ...input.target,
          prompt: {
            ...input.target.prompt,
            model: { ...input.target.prompt.model, [field]: value },
          },
        },
      }),
    ).toThrow();
  },
);

test("rejects text alongside a workflow on create and nested patch without persisting", async () => {
  const parts = [
    ...input.target.prompt.parts,
    {
      type: "workflow" as const,
      workflow: "default:workflows/multi-turn-debate.workflow.ts",
      args: { round: 3, topic: "Should I buy AAPL?" },
    },
  ];
  const invalid = {
    ...input,
    target: { ...input.target, prompt: { ...input.target.prompt, parts } },
  };
  await expect(caller.resources.agent_schedule.create(invalid)).rejects.toThrow(
    "Saved prompts require an optional quote, then text or one command, then images.",
  );
  const created = await caller.resources.agent_schedule.create(input);
  await expect(
    caller.resources.agent_schedule.patch({
      id: created.id,
      expectedRevision: created.revision,
      operations: [
        { op: "replace", path: "/target/prompt/parts", value: parts },
      ],
    }),
  ).rejects.toThrow(
    "Saved prompts require an optional quote, then text or one command, then images.",
  );
  expect(await caller.resources.agent_schedule.list()).toEqual({
    items: [created],
    nextCursor: null,
  });
});

test("keeps backend cursors on rename/pause and recalculates on enable or recurrence changes", async () => {
  const created = await runtime.runPromise(
    Transactor.run(
      agentScheduleResource.transitions.create({
        ...Schema.decodeUnknownSync(agentScheduleResource.createSchema)(input),
        nextFireAt: 1,
      }),
    ),
  );
  expect(created.nextFireAt).toBe(1);
  const paused = await caller.resources.agent_schedule.patch({
    id: created.id,
    expectedRevision: 1,
    operations: [{ op: "replace", path: "/enabled", value: false }],
  });
  expect(paused.nextFireAt).toBe(1);
  const enabled = await caller.resources.agent_schedule.patch({
    id: created.id,
    expectedRevision: 2,
    operations: [{ op: "replace", path: "/enabled", value: true }],
  });
  expect(enabled.nextFireAt).toBe(Date.parse(input.recurrence.fireAt));
  const changed = await caller.resources.agent_schedule.patch({
    id: created.id,
    expectedRevision: 3,
    operations: [
      {
        op: "replace",
        path: "/recurrence",
        value: { kind: "once", fireAt: "2091-01-01T00:00:00.000Z" },
      },
    ],
  });
  expect(changed.nextFireAt).toBe(Date.parse("2091-01-01T00:00:00.000Z"));
  const body = Struct.omit(changed, ENVELOPE_FIELD_NAMES);
  await runtime.runPromise(
    Transactor.run(
      Transition.from((tx) =>
        agentScheduleStore.save(tx, changed.id, {
          revision: 5,
          body: { ...body, nextFireAt: 2 },
        }),
      ),
    ),
  );
  expect(
    (await caller.resources.agent_schedule.get({ id: created.id })).nextFireAt,
  ).toBe(2);
  const before = Date.now();
  const cron = await caller.resources.agent_schedule.create({
    ...input,
    recurrence: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" },
  });
  expect(cron.nextFireAt).toBeGreaterThan(before);
  expect(cron.nextFireAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
});

test("rejects managed fields and exhausted recurrence without writes or events", async () => {
  const events = await runtime.runPromise(Events.Service);
  const publish = vi.spyOn(events, "publish");
  for (const invalid of [
    { ...input, nextFireAt: 1 },
    { ...input, userId: "user" },
    { ...input, deletedAt: 1 },
    { ...input, name: "   " },
    { ...input, target: { ...input.target, surprise: true } },
    {
      ...input,
      recurrence: { kind: "once", fireAt: "2020-01-01T00:00:00.000Z" },
    },
    {
      ...input,
      recurrence: { kind: "cron", expression: "bad", timeZone: "UTC" },
    },
  ]) {
    await expect(
      caller.resources.agent_schedule.create(invalid as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(publish).not.toHaveBeenCalled();
  expect(await caller.resources.agent_schedule.list()).toEqual({
    items: [],
    nextCursor: null,
  });
  const created = await caller.resources.agent_schedule.create(input);
  publish.mockClear();
  for (const [path, value] of [
    ["/nextFireAt", 2],
    ["/recurrence", { kind: "once", fireAt: "2020-01-01T00:00:00.000Z" }],
  ] as const) {
    await expect(
      caller.resources.agent_schedule.patch({
        id: created.id,
        expectedRevision: 1,
        operations: [{ op: "replace", path, value }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(await caller.resources.agent_schedule.get({ id: created.id })).toEqual(
    created,
  );
  expect(publish).not.toHaveBeenCalled();
});
