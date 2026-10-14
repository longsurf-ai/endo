// Purpose: Render one schedule with automatic-run controls and expandable history.
import {
  ChevronDownIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@openchart/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@openchart/app/components/ui/dialog";
import { Switch } from "@openchart/app/components/ui/form/switch";
import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";
import { Card, CardItem } from "@openchart/app/components/ui/settings/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@openchart/app/components/ui/collapsible/collapsible";
import {
  useToggleSchedule,
  useRunSchedule,
  useDeleteSchedule,
  type Schedule,
} from "@openchart/app/features/schedule/api/queries";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

import { formatRecurrence, formatTime } from "./schedule-format";
import { ScheduleHistory } from "./schedule-history";

/** Render schedule controls; the owner opens the editor and Collapsible owns lazy history mounting. @example <ScheduleItem transport={transport} schedule={schedule} onOpenSession={openSession} onEdit={edit} /> */
export function ScheduleItem({
  transport,
  schedule,
  onOpenSession,
  onEdit,
}: {
  transport: AppTransport;
  schedule: Schedule;
  onOpenSession: (sessionID: string) => void;
  onEdit: () => void;
}) {
  const toggle = useToggleSchedule(transport);
  const run = useRunSchedule(transport);
  const recurrence = schedule.recurrence;
  const timeZone = recurrence.kind === "cron" ? recurrence.timeZone : undefined;
  return (
    <Card>
      <Collapsible>
        <CardItem
          className="gap-3 border-none pb-0 [&>div:first-child]:min-w-0"
          title={
            <CollapsibleTrigger className="group flex max-w-full items-start gap-2 rounded-sm text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDownIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 -rotate-90 transition-transform group-data-[panel-open]:rotate-0 motion-reduce:transition-none"
              />
              <span className="min-w-0 break-words">{schedule.name}</span>
            </CollapsibleTrigger>
          }
          description={
            <span className="block break-words text-xs">
              {formatRecurrence(recurrence)}
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              <DeleteScheduleButton transport={transport} schedule={schedule} />
              <TooltipIconButton
                tooltip="Edit schedule"
                aria-label={`Edit ${schedule.name}`}
                className="size-8 text-foreground"
                icon={<PencilIcon className="size-4" />}
                onClick={onEdit}
              />
              <TooltipIconButton
                tooltip="Run now"
                aria-label={`Run ${schedule.name} now`}
                className="size-8 text-foreground"
                disabled={run.isPending}
                isLoading={run.isPending}
                icon={<PlayIcon className="size-4" />}
                onClick={() =>
                  run.mutate(schedule.id, {
                    onSuccess: (occurrence) =>
                      occurrence.sessionId &&
                      onOpenSession(occurrence.sessionId),
                  })
                }
              />
              <Switch
                checked={schedule.enabled}
                loading={toggle.isPending}
                aria-label={`Enable ${schedule.name}`}
                onCheckedChange={() => toggle.mutate(schedule)}
              />
            </div>
          }
        />
        <dl className="mt-3 flex items-baseline gap-2 rounded-lg bg-muted px-3 py-2.5 text-sm">
          <dt className="shrink-0 font-mono text-xs text-muted-foreground">
            {recurrence.kind === "cron" ? "Next run" : "Status"}
          </dt>
          <dd className="min-w-0 break-words">
            {!schedule.enabled ? (
              "Disabled"
            ) : recurrence.kind === "cron" ? (
              <time
                className="text-foreground"
                dateTime={new Date(schedule.nextFireAt).toISOString()}
              >
                {formatTime(schedule.nextFireAt, timeZone)}
              </time>
            ) : (
              "Enabled"
            )}
          </dd>
        </dl>

        <CollapsibleContent>
          <ScheduleHistory
            transport={transport}
            schedule={schedule}
            onOpenSession={onOpenSession}
          />
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function DeleteScheduleButton({
  transport,
  schedule,
}: {
  transport: AppTransport;
  schedule: Schedule;
}) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteSchedule(transport);
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (remove.isPending) return;
        setOpen(open);
        if (open) remove.reset();
      }}
    >
      <DialogTrigger asChild>
        <TooltipIconButton
          tooltip="Delete schedule"
          aria-label={`Delete ${schedule.name}`}
          className="size-8 text-foreground hover:text-destructive"
          icon={<Trash2Icon className="size-4" />}
        />
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md lg:max-w-md xl:max-w-md"
        aria-busy={remove.isPending}
      >
        <DialogHeader>
          <DialogTitle>Delete schedule</DialogTitle>
          <DialogDescription className="break-words">
            Delete “{schedule.name}” and its run history? This cannot be undone.
            Existing conversations will be kept.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            isLoading={remove.isPending}
            onClick={() =>
              remove.mutate(schedule.id, { onSuccess: () => setOpen(false) })
            }
          >
            {remove.isPending ? "Deleting…" : "Delete schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
