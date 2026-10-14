// Purpose: Format schedule recurrence descriptions and run times for display.
import cronstrue from "cronstrue";

import type { Schedule } from "@openchart/app/features/schedule/api/queries";

/** Describe a recurrence using its authored cron time zone or the local one-time date. @example formatRecurrence(schedule.recurrence); */
export function formatRecurrence(recurrence: Schedule["recurrence"]) {
  if (recurrence.kind === "once") {
    return `Once on ${formatTime(Date.parse(recurrence.fireAt))}`;
  }
  const description = cronstrue.toString(recurrence.expression, {
    verbose: true,
    trimHoursLeadingZero: true,
    logicalAndDayFields: false,
  });
  const timeZone = new Intl.DateTimeFormat("en", {
    timeZone: recurrence.timeZone,
    timeZoneName: "longGeneric",
  })
    .formatToParts()
    .find((part) => part.type === "timeZoneName")?.value;
  return `${description} (${timeZone ?? recurrence.timeZone})`;
}

/** Format a run instant for display; omitted time zones use the browser default. @example formatTime(schedule.nextFireAt, "America/New_York"); */
export function formatTime(value: number, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}
