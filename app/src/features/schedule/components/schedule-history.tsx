// Purpose: Page accepted schedule runs and open their Sessions.
import { useInfiniteQuery } from "@tanstack/react-query";

import { Button } from "@openchart/app/components/ui/button";
import { LoadMore } from "@openchart/app/components/ui/load-more/load-more";
import {
  scheduleOccurrencesQueryOptions,
  type Schedule,
} from "@openchart/app/features/schedule/api/queries";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

import { formatTime } from "./schedule-format";
import { ScheduleQueryError } from "./schedule-query-error";

/** Read history while mounted and expose query retry/pagination; the caller opens Sessions. @example <ScheduleHistory transport={transport} schedule={schedule} onOpenSession={openSession} /> */
export function ScheduleHistory({
  transport,
  schedule,
  onOpenSession,
}: {
  transport: AppTransport;
  schedule: Schedule;
  onOpenSession: (sessionID: string) => void;
}) {
  const occurrences = useInfiniteQuery(
    scheduleOccurrencesQueryOptions(transport, schedule.id),
  );
  const timeZone =
    schedule.recurrence.kind === "cron"
      ? schedule.recurrence.timeZone
      : undefined;
  return (
    <div className="mt-3 border-t border-border/40 pt-3">
      <h3 className="mb-2 text-sm font-medium text-foreground">Run history</h3>
      {occurrences.isPending ? (
        <p role="status" className="text-sm">
          Loading runs…
        </p>
      ) : null}
      {occurrences.isError && !occurrences.isFetchNextPageError ? (
        <ScheduleQueryError
          message="Couldn’t load runs."
          retry={() => {
            void occurrences.refetch();
          }}
        />
      ) : null}
      {occurrences.data?.length === 0 ? (
        <p className="text-sm">No runs yet.</p>
      ) : null}
      <ul aria-label={`Runs for ${schedule.name}`}>
        {occurrences.data?.map((occurrence) => (
          <li key={occurrence.id}>
            <Button
              variant="ghost"
              className="h-auto w-full justify-start rounded-md px-2 py-2 text-left font-normal"
              // An Occurrence without a Run has no Session to open.
              disabled={occurrence.sessionId === null}
              onClick={() =>
                occurrence.sessionId && onOpenSession(occurrence.sessionId)
              }
            >
              <time
                className="min-w-0 whitespace-normal"
                dateTime={new Date(occurrence.fireAt).toISOString()}
              >
                {formatTime(occurrence.fireAt, timeZone)}
              </time>
            </Button>
          </li>
        ))}
      </ul>
      <LoadMore
        hasMore={occurrences.hasNextPage}
        loading={occurrences.isFetching}
        error={occurrences.isFetchNextPageError}
        onLoadMore={() => {
          void occurrences.fetchNextPage();
        }}
        label={`Show more runs for ${schedule.name}`}
      />
    </div>
  );
}
