// Purpose: Calendar navigation and view tabs from shared controls.
import type { CalendarController } from "@fullcalendar/react";

import { Button } from "@openchart/app/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@openchart/app/components/ui/tabs";
import { cn } from "@openchart/app/utils/cn";

import {
  EventCalendarNextIcon,
  EventCalendarPrevIcon,
} from "./event-calendar-icons";

export interface EventCalendarToolbarProps {
  className?: string;
  controller: CalendarController;
  availableViews: string[];
}

/** Today/prev/next navigation, the current title and one tab per available view. @example <EventCalendarToolbar controller={controller} availableViews={views} /> */
export function EventCalendarToolbar({
  className,
  controller,
  availableViews,
}: EventCalendarToolbarProps) {
  const buttons = controller.getButtonState();

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-3">
        <Button
          onClick={() => controller.today()}
          aria-label={buttons.today.hint}
          variant="outline"
        >
          {buttons.today.text}
        </Button>
        <div className="flex items-center">
          <Button
            onClick={() => controller.prev()}
            disabled={buttons.prev.isDisabled}
            aria-label={buttons.prev.hint}
            variant="ghost"
            size="icon"
          >
            <EventCalendarPrevIcon />
          </Button>
          <Button
            onClick={() => controller.next()}
            disabled={buttons.next.isDisabled}
            aria-label={buttons.next.hint}
            variant="ghost"
            size="icon"
          >
            <EventCalendarNextIcon />
          </Button>
        </div>
        <div className="text-xl">{controller.view?.title}</div>
      </div>
      <Tabs value={controller.view?.type ?? availableViews[0]}>
        <TabsList>
          {availableViews.map((availableView) => (
            <TabsTrigger
              key={availableView}
              value={availableView}
              onClick={() => controller.changeView(availableView)}
              aria-label={buttons[availableView]?.hint}
            >
              {buttons[availableView]?.text}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
