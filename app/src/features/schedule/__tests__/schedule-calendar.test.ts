// Purpose: Prove the calendar projection is complete, zone-aware and merges only touching fires.
import { expect, test } from "vitest";

import type { Schedule } from "@openchart/app/features/schedule/api/queries";
import {
  scheduleCalendarEvents,
  scheduleFires,
} from "@openchart/app/features/schedule/components/schedule-calendar";

const week = {
  start: new Date("2026-09-21T00:00:00.000Z"),
  end: new Date("2026-09-28T00:00:00.000Z"),
};

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "ags_daily" as Schedule["id"],
    revision: 1,
    createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
    name: "Morning briefing",
    enabled: true,
    recurrence: {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "America/New_York",
    },
    nextFireAt: Date.parse("2026-09-21T13:00:00.000Z"),
    target: {
      kind: "agent_prompt",
      prompt: {
        agent: "default",
        model: { providerID: "codex", modelID: "tier1" },
        parts: [{ type: "text", text: "Summarize the market" }],
      },
      binding: { key: "schedule-binding" },
    },
    ...overrides,
  };
}

test("expands every cron fire in the authored zone and never before the schedule existed", () => {
  expect(
    scheduleFires(schedule(), week).map((fire) => fire.toISOString()),
  ).toEqual([21, 22, 23, 24, 25].map((day) => `2026-09-${day}T13:00:00.000Z`));
  const createdAt = Date.parse("2026-09-23T13:00:00.000Z");
  expect(scheduleFires(schedule({ createdAt }), week)).toHaveLength(3);
  expect(
    scheduleFires(
      schedule({
        recurrence: { kind: "once", fireAt: "2026-09-24T07:30:00.000Z" },
      }),
      week,
    ),
  ).toEqual([new Date("2026-09-24T07:30:00.000Z")]);
  expect(
    scheduleFires(
      schedule({
        recurrence: { kind: "once", fireAt: "2026-09-28T00:00:00.000Z" },
      }),
      week,
    ),
  ).toEqual([]);
});

test("merges touching fires of one schedule into a band and skips disabled schedules", () => {
  const events = scheduleCalendarEvents(
    [
      schedule({
        id: "ags_frequent" as Schedule["id"],
        recurrence: {
          kind: "cron",
          expression: "*/10 9-10 * * 1",
          timeZone: "UTC",
        },
      }),
      schedule({ enabled: false }),
    ],
    week,
  );
  expect(events).toEqual([
    expect.objectContaining({
      id: "ags_frequent:1789981200000",
      title: "Morning briefing",
      start: new Date("2026-09-21T09:00:00.000Z"),
      end: new Date("2026-09-21T11:20:00.000Z"),
      extendedProps: {
        schedule: expect.objectContaining({ id: "ags_frequent" }),
      },
    }),
  ]);
  expect(scheduleCalendarEvents([schedule()], week)).toHaveLength(5);
});

test("shows a one-time draft as a placeholder block and ignores cron drafts", () => {
  const fireAt = "2026-09-22T11:00:00.000Z";
  expect(scheduleCalendarEvents([], week, { kind: "once", fireAt })).toEqual([
    {
      id: "placeholder",
      title: "New schedule",
      start: new Date(fireAt),
      end: new Date("2026-09-22T11:30:00.000Z"),
    },
  ]);
  expect(
    scheduleCalendarEvents([], week, {
      kind: "cron",
      expression: "0 8 * * *",
      timeZone: "UTC",
    }),
  ).toEqual([]);
});
