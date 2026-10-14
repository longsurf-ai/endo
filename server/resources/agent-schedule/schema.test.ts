// Purpose: Locks Schedule recurrence parsing, normalization, and strict field ownership.

import { Schema } from "effect";
import { expect, test } from "vitest";
import { AgentScheduleCronRecurrence, AgentScheduleRecurrence } from "./schema";

const decode = Schema.decodeUnknownSync(AgentScheduleRecurrence);

test("normalizes cron input and encodes the same durable recurrence shape", () => {
  const recurrence = decode({
    kind: "cron",
    expression: "  0 9 * * 1-5  ",
    timeZone: " America/New_York ",
  });
  expect(recurrence).toEqual({
    kind: "cron",
    expression: "0 9 * * 1-5",
    timeZone: "America/New_York",
  });
  expect(Schema.encodeSync(AgentScheduleRecurrence)(recurrence)).toEqual(
    recurrence,
  );
});

test("rejects invalid and unsupported cron recurrence without starting a scheduler", () => {
  for (const expression of [
    "",
    "   ",
    "0 0 0 * * *",
    "0 0 ? * *",
    "0 0 L * *",
    "0 0 1W * *",
    "0 0 * * 1#2",
    "0 0 * * 5L",
    "0 0 * * +1",
    "60 0 * * *",
    "0 0 31 2 *",
  ]) {
    expect(() =>
      decode({ kind: "cron", expression, timeZone: "UTC" }),
    ).toThrow();
  }
  for (const timeZone of ["", "   ", "Invalid/Zone"]) {
    expect(() =>
      decode({ kind: "cron", expression: "0 9 * * *", timeZone }),
    ).toThrow();
  }
});

test("retains the invalid cron expression path at the Standard Schema boundary", async () => {
  const result = await Schema.toStandardSchemaV1(AgentScheduleCronRecurrence)[
    "~standard"
  ].validate({ kind: "cron", expression: "0 0 L * *", timeZone: "UTC" });
  expect(result).toMatchObject({
    issues: [{ path: ["expression"] }],
  });
});

test("accepts only exact canonical UTC instants for once recurrence", () => {
  const recurrence = { kind: "once", fireAt: "2028-02-29T00:00:00.000Z" };
  expect(decode(recurrence)).toEqual(recurrence);
  for (const fireAt of [
    "2026-09-06T00:00:00Z",
    "2026-09-06T00:00:00.000+00:00",
    "2026-09-06T00:00:00.0000Z",
    "2026-02-29T00:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
    "invalid",
    "",
  ]) {
    expect(() => decode({ kind: "once", fireAt })).toThrow();
  }
});

test("rejects undeclared fields, incomplete variants, and unknown kinds", () => {
  for (const recurrence of [
    { kind: "cron", expression: "0 9 * * *", timeZone: "UTC", extra: true },
    { kind: "once", fireAt: "2026-09-06T00:00:00.000Z", extra: true },
    { kind: "cron", expression: "0 9 * * *" },
    { kind: "once" },
    { kind: "interval", seconds: 60 },
  ]) {
    expect(() => decode(recurrence)).toThrow();
  }
});
