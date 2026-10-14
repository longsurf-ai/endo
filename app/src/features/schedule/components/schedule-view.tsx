// Purpose: Browse persisted schedules as a list or calendar and own the one editing draft.
import { useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";

import { Button } from "@openchart/app/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@openchart/app/components/ui/empty/empty";
import { LoadMore } from "@openchart/app/components/ui/load-more/load-more";
import { schedulesQueryOptions } from "@openchart/app/features/schedule/api/queries";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

import { ScheduleCalendar } from "./schedule-calendar";
import {
  ScheduleEditDialog,
  type ScheduleDraft,
  type ScheduleEditDialogProps,
} from "./schedule-edit-dialog";
import { ScheduleItem } from "./schedule-item";
import { ScheduleQueryError } from "./schedule-query-error";

type ScheduleViewProps = {
  transport: AppTransport;
  renderHeader: (createAction: ReactNode) => ReactNode;
  renderCreateAction?: (open: () => void) => ReactNode;
  /** The app chooses the view, typically from the URL. */
  view: "list" | "calendar";
  onOpenSession: (sessionID: string) => void;
  renderPromptEditor: ScheduleEditDialogProps["renderPromptEditor"];
};

/** Own one draft for list and calendar editing; app slots place the creation control and prompt editor. @example <ScheduleView transport={transport} renderHeader={header} view="list" onOpenSession={openSession} renderPromptEditor={renderPromptEditor} /> */
export function ScheduleView({
  transport,
  renderHeader,
  renderCreateAction,
  view,
  onOpenSession,
  renderPromptEditor,
}: ScheduleViewProps) {
  const schedules = useInfiniteQuery(schedulesQueryOptions(transport));
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const openCreate = () => setDraft({});
  const createAction = renderCreateAction ? (
    renderCreateAction(openCreate)
  ) : (
    <Button onClick={openCreate}>
      <Plus aria-hidden="true" />
      Create schedule
    </Button>
  );
  // The draft keeps the revision it opened with; the live list reveals remote edits.
  const stale =
    !!draft?.schedule &&
    schedules.data?.find((schedule) => schedule.id === draft.schedule?.id)
      ?.revision !== draft.schedule.revision;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Schedule"
    >
      {renderHeader(createAction)}
      {view === "calendar" ? (
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <ScheduleCalendar
            className="min-h-0 flex-1"
            schedules={schedules.data ?? []}
            placeholder={draft?.recurrence}
            onEdit={(schedule) => setDraft({ schedule })}
            onCreate={(recurrence) => setDraft({ recurrence })}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
            {schedules.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading schedules…
              </p>
            ) : null}
            {schedules.isError && !schedules.isFetchNextPageError ? (
              <ScheduleQueryError
                message="Couldn’t load schedules."
                retry={() => {
                  void schedules.refetch();
                }}
              />
            ) : null}
            {schedules.data?.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarClock aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No schedules yet</EmptyTitle>
                  <EmptyDescription>
                    Run a prompt on a schedule.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ul className="space-y-3" aria-label="Schedules">
                  {schedules.data?.map((schedule) => (
                    <li key={schedule.id}>
                      <ScheduleItem
                        transport={transport}
                        schedule={schedule}
                        onOpenSession={onOpenSession}
                        onEdit={() => setDraft({ schedule })}
                      />
                    </li>
                  ))}
                </ul>
                <LoadMore
                  hasMore={schedules.hasNextPage}
                  loading={schedules.isFetching}
                  error={schedules.isFetchNextPageError}
                  onLoadMore={() => {
                    void schedules.fetchNextPage();
                  }}
                  label="Show more schedules"
                />
              </>
            )}
          </div>
        </div>
      )}
      <ScheduleEditDialog
        transport={transport}
        draft={draft}
        stale={stale}
        onClose={() => setDraft(null)}
        renderPromptEditor={renderPromptEditor}
      />
    </section>
  );
}
