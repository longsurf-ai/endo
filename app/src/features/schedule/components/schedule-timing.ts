// Purpose: Adapt V1's timing presets to V2's canonical recurrence contract.
import type { Schedule } from "@openchart/app/features/schedule/api/queries";

export const scheduleFrequencies = [
  { value: "once", name: "Once" },
  { value: "hourly", name: "Hourly" },
  { value: "daily", name: "Daily" },
  { value: "weekdays", name: "Weekdays" },
  { value: "weekly", name: "Weekly" },
  { value: "custom", name: "Custom" },
] as const;

type Frequency = (typeof scheduleFrequencies)[number]["value"];
/** Transient timing fields; incomplete input stays local until submission. */
export type ScheduleTiming = {
  frequency: Frequency;
  time: string;
  day: string;
  timeZone: string;
  expression: string;
  date: string;
};

/** Format a local date for the native date/time field, without UTC conversion. @example localScheduleDateTime(new Date()); */
export function localScheduleDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Recognize only supported presets; all other expressions remain editable verbatim as Custom. @example scheduleTiming(schedule.recurrence); */
export function scheduleTiming(
  recurrence: Schedule["recurrence"],
): ScheduleTiming {
  const draft: ScheduleTiming = {
    frequency: "once",
    time: "08:00",
    day: "1",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    expression: "0 8 * * 1-5",
    date: "",
  };
  if (recurrence.kind === "once") {
    const dateTime = localScheduleDateTime(new Date(recurrence.fireAt));
    return {
      ...draft,
      date: dateTime.slice(0, 10),
      time: dateTime.slice(11),
    };
  }
  draft.frequency = "custom";
  draft.timeZone = recurrence.timeZone;
  draft.expression = recurrence.expression;
  const [minute, hour, date, month, day] = recurrence.expression
    .trim()
    .split(/\s+/);
  if (date !== "*" || month !== "*") return draft;
  if (minute === "0" && hour === "*" && day === "*") {
    return { ...draft, frequency: "hourly" };
  }
  if (!/^\d{1,2}$/.test(minute ?? "") || !/^\d{1,2}$/.test(hour ?? ""))
    return draft;
  draft.time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  if (day === "*") draft.frequency = "daily";
  else if (day === "1-5") draft.frequency = "weekdays";
  else if (/^[0-7]$/.test(day ?? "")) {
    draft.frequency = "weekly";
    draft.day = String(Number(day) % 7);
  }
  return draft;
}

/** Convert local form input to recurrence; the server owns cron validation and the next-run cursor. @example scheduleRecurrence(timing); */
export function scheduleRecurrence(
  timing: ScheduleTiming,
): Schedule["recurrence"] {
  if (timing.frequency === "once") {
    const dateTime = `${timing.date}T${timing.time}`;
    const date = new Date(dateTime);
    if (
      !Number.isFinite(date.getTime()) ||
      localScheduleDateTime(date) !== dateTime
    ) {
      throw new Error("Choose a valid date and time.");
    }
    if (date.getTime() <= Date.now())
      throw new Error("Choose a future date and time.");
    return { kind: "once", fireAt: date.toISOString() };
  }
  const [hour, minute] = timing.time.split(":").map(Number);
  const expressions = {
    hourly: "0 * * * *",
    daily: `${minute} ${hour} * * *`,
    weekdays: `${minute} ${hour} * * 1-5`,
    weekly: `${minute} ${hour} * * ${timing.day}`,
    custom: timing.expression.trim(),
  };
  return {
    kind: "cron",
    expression: expressions[timing.frequency],
    timeZone: timing.timeZone,
  };
}
