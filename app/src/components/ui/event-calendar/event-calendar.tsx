// Purpose: Shared event calendar; one toolbar and theme for every FullCalendar consumer.
// Consumers own their add action, so the toolbar has no add button.
import {
  type CalendarOptions,
  useCalendarController,
} from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import listPlugin from "@fullcalendar/react/list";
import multiMonthPlugin from "@fullcalendar/react/multimonth";
import timeGridPlugin from "@fullcalendar/react/timegrid";

import { cn } from "@openchart/app/utils/cn";

import { EventCalendarCloseIcon } from "./event-calendar-icons";
import { EventCalendarToolbar } from "./event-calendar-toolbar";
import { EventCalendarViews } from "./event-calendar-views";

const plugins = [
  dayGridPlugin,
  timeGridPlugin,
  listPlugin,
  interactionPlugin,
  multiMonthPlugin,
];
const defaultAvailableViews = [
  "dayGridMonth",
  "timeGridWeek",
  "timeGridDay",
  "listWeek",
  "multiMonthYear",
];
const navLinkDayClick = "timeGridDay";
const navLinkWeekClick = "timeGridWeek";

export interface EventCalendarProps extends Omit<
  CalendarOptions,
  "class" | "className" | "headerToolbar" | "footerToolbar"
> {
  className?: string;
  /** View types offered by the toolbar; the first one opens initially. */
  availableViews?: string[];
}

/** FullCalendar with the shared toolbar and theme; every other FullCalendar option passes through. @example <EventCalendar events={events} availableViews={["timeGridWeek"]} /> */
export function EventCalendar({
  availableViews = defaultAvailableViews,
  className,
  height,
  contentHeight,
  direction,
  plugins: userPlugins = [],
  ...restOptions
}: EventCalendarProps) {
  const controller = useCalendarController();

  const hasBorderX = !(restOptions.borderlessX ?? restOptions.borderless);
  const hasBorderTop = !(restOptions.borderlessTop ?? restOptions.borderless);
  const hasBorderBottom = !(
    restOptions.borderlessBottom ?? restOptions.borderless
  );
  const isHeightAuto = height === "auto" || contentHeight === "auto";

  return (
    <div
      className={cn(
        className,
        "flex flex-col bg-background",
        hasBorderX && "border-x",
        hasBorderTop && "border-t",
        hasBorderBottom && "border-b",
        hasBorderTop && hasBorderX && "rounded-t-lg",
        hasBorderBottom && hasBorderX && "rounded-b-lg",
        !isHeightAuto && "overflow-hidden",
      )}
      style={{ height }}
      dir={direction === "rtl" ? "rtl" : undefined}
    >
      <EventCalendarToolbar
        className="p-4"
        controller={controller}
        availableViews={availableViews}
      />
      <div className="min-h-0 grow">
        <EventCalendarViews
          controller={controller}
          height={
            isHeightAuto
              ? "auto"
              : height !== undefined
                ? "100%"
                : contentHeight
          }
          initialView={availableViews[0]}
          navLinkDayClick={navLinkDayClick}
          navLinkWeekClick={navLinkWeekClick}
          plugins={[...plugins, ...userPlugins]}
          popoverCloseContent={() => <EventCalendarCloseIcon />}
          {...restOptions}
        />
      </div>
    </div>
  );
}
