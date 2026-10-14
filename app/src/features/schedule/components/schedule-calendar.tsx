// Purpose: Project enabled schedules onto the shared event calendar and turn clicks into dialog drafts.
import { useMemo, useState } from "react";
import type { EventInput } from "@fullcalendar/react";
import { Cron } from "croner";

import { EventCalendar } from "@openchart/app/components/ui/event-calendar";
import type { Schedule } from "@openchart/app/features/schedule/api/queries";

/** Fires are instants; each one is drawn as a short block so it stays clickable. */
const EVENT_MS = 30 * 60_000;
const colors = [
  "blue",
  "orange",
  "teal",
  "cyan",
  "purple",
  "magenta",
  "amber",
  "green",
];

type Range = { start: Date; end: Date };

/**
 * Every fire of one schedule inside [start, end), never sampled. Cron fires use the
 * Scheduler's croner options; nothing projects before the schedule existed.
 * @example scheduleFires(schedule, { start: weekStart, end: weekEnd });
 */
export function scheduleFires(schedule: Schedule, { start, end }: Range) {
  const from = Math.max(start.getTime(), schedule.createdAt);
  const { recurrence } = schedule;
  if (recurrence.kind === "once") {
    const fireAt = new Date(recurrence.fireAt);
    return fireAt.getTime() >= from && fireAt < end ? [fireAt] : [];
  }
  const cron = new Cron(recurrence.expression, {
    mode: "5-part",
    paused: true,
    timezone: recurrence.timeZone,
  });
  const fires: Date[] = [];
  // nextRun excludes its argument, so step back to include a fire exactly at `from`.
  for (
    let next = cron.nextRun(new Date(from - 1));
    next && next < end;
    next = cron.nextRun(next)
  )
    fires.push(next);
  return fires;
}

/**
 * Calendar events for the visible range. Fires of one schedule that overlap or touch merge
 * into one block, so a five-minute cron reads as a band rather than hundreds of slivers.
 * A one-time draft, such as a clicked slot, appears as a placeholder while its dialog is open.
 * @example scheduleCalendarEvents(schedules, range, draft?.recurrence);
 */
export function scheduleCalendarEvents(
  schedules: Schedule[],
  range: Range,
  placeholder?: Schedule["recurrence"],
) {
  const events: EventInput[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const blocks: Range[] = [];
    for (const start of scheduleFires(schedule, range)) {
      const end = new Date(start.getTime() + EVENT_MS);
      const last = blocks.at(-1);
      if (last && start <= last.end) last.end = end;
      else blocks.push({ start, end });
    }
    const hash = [...schedule.id].reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0,
    );
    for (const block of blocks)
      events.push({
        id: `${schedule.id}:${block.start.getTime()}`,
        title: schedule.name,
        ...block,
        color: `var(--indicator-${colors[hash % colors.length]})`,
        extendedProps: { schedule },
      });
  }
  if (placeholder?.kind === "once") {
    const start = new Date(placeholder.fireAt);
    events.push({
      id: "placeholder",
      title: "New schedule",
      start,
      end: new Date(start.getTime() + EVENT_MS),
    });
  }
  return events;
}

/** Read-only week/day projection; events open their schedule and empty slots start a one-time draft, shown as a placeholder while open. @example <ScheduleCalendar schedules={schedules} placeholder={draft?.recurrence} onEdit={edit} onCreate={create} /> */
export function ScheduleCalendar({
  schedules,
  placeholder,
  onEdit,
  onCreate,
  className,
}: {
  schedules: Schedule[];
  placeholder?: Schedule["recurrence"];
  onEdit: (schedule: Schedule) => void;
  onCreate: (recurrence: Schedule["recurrence"]) => void;
  className?: string;
}) {
  const [range, setRange] = useState<Range>();
  const events = useMemo(
    () => (range ? scheduleCalendarEvents(schedules, range, placeholder) : []),
    [schedules, range, placeholder],
  );
  return (
    <EventCalendar
      className={className}
      height="100%"
      // Croner steps minute by minute in the authored zone, so a month of dense fires would stall.
      availableViews={["timeGridWeek", "timeGridDay"]}
      nowIndicator
      // Schedules fire at instants, so there is no all-day row to click.
      allDaySlot={false}
      events={events}
      datesSet={(info) => setRange({ start: info.start, end: info.end })}
      eventClick={(info) => {
        // The placeholder carries no schedule.
        const schedule: Schedule | undefined =
          info.event.extendedProps.schedule;
        if (schedule) onEdit(schedule);
      }}
      dateClick={(info) =>
        onCreate({ kind: "once", fireAt: info.date.toISOString() })
      }
    />
  );
}
