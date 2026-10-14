// Purpose: Create and edit schedules with one form and an app-supplied prompt editor.
import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@openchart/app/components/ui/dialog";
import { Button } from "@openchart/app/components/ui/button";
import { Combobox } from "@openchart/app/components/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@openchart/app/components/ui/field";
import { Input } from "@openchart/app/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@openchart/app/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@openchart/app/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@openchart/app/components/ui/toggle-group";
import {
  useSaveSchedule,
  type Schedule,
  type SchedulePrompt,
} from "@openchart/app/features/schedule/api/queries";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import {
  localScheduleDateTime,
  scheduleFrequencies,
  scheduleRecurrence,
  scheduleTiming,
  type ScheduleTiming,
} from "./schedule-timing";

const weekdays = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["0", "Sunday"],
] as const;

// The schedule list does not need to load the calendar until its picker opens.
const Calendar = lazy(() =>
  import("@openchart/app/components/ui/calendar").then(({ Calendar }) => ({
    default: Calendar,
  })),
);

// Minute precision matches our schedule contract.
const timeInputClassName =
  "appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none";

// The form consumes editor output without knowing its runtime or implementation.
type PromptEditor = {
  content: ReactNode;
  changed: boolean;
  ready: boolean;
  read: () => Promise<SchedulePrompt | undefined>;
};

/** What the dialog edits: an existing schedule, or a new one that may start from a recurrence such as a clicked calendar slot. */
export type ScheduleDraft = {
  schedule?: Schedule;
  recurrence?: Schedule["recurrence"];
};

export type ScheduleEditDialogProps = {
  transport: AppTransport;
  /** Captured by the opener; null keeps the dialog closed. */
  draft: ScheduleDraft | null;
  /** The captured schedule changed remotely, so saving requires reopening. */
  stale: boolean;
  onClose: () => void;
  renderPromptEditor: (props: {
    prompt?: Extract<Schedule["target"], { kind: "agent_prompt" }>["prompt"];
    disabled: boolean;
    onCancel: () => void;
    children: (editor: PromptEditor) => ReactNode;
  }) => ReactNode;
};

/** Host the same creation form outside ScheduleView, such as from Feed. @example <ScheduleCreateAction transport={transport} renderTrigger={menu} renderPromptEditor={editor} /> */
export function ScheduleCreateAction({
  transport,
  renderTrigger,
  renderPromptEditor,
}: Pick<ScheduleEditDialogProps, "transport" | "renderPromptEditor"> & {
  renderTrigger: (open: () => void) => ReactNode;
}) {
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  return (
    <>
      {renderTrigger(() => setDraft({}))}
      <ScheduleEditDialog
        transport={transport}
        draft={draft}
        stale={false}
        onClose={() => setDraft(null)}
        renderPromptEditor={renderPromptEditor}
      />
    </>
  );
}

/**
 * Edit the captured draft and save through Query; the opener owns the draft and its revision check.
 * The app supplies the prompt editor; this feature owns the Dialog, form and timing.
 * Cancel discards the draft; failures retain it and remote changes require reopening.
 * @example <ScheduleEditDialog transport={transport} draft={draft} stale={stale} onClose={close} renderPromptEditor={renderPromptEditor} />
 */
export function ScheduleEditDialog({
  transport,
  draft,
  stale,
  onClose,
  renderPromptEditor,
}: ScheduleEditDialogProps) {
  const save = useSaveSchedule(transport);
  const close = () => {
    save.reset();
    onClose();
  };
  const form = (promptEditor: PromptEditor) =>
    draft && (
      <ScheduleEditForm
        draft={draft}
        stale={stale}
        save={save}
        onClose={close}
        promptEditor={promptEditor}
      />
    );
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      {draft ? (
        <DialogContent
          className="sm:max-w-lg lg:max-w-lg xl:max-w-lg"
          aria-busy={save.isPending}
        >
          <DialogHeader>
            <DialogTitle>
              {draft.schedule ? "Edit schedule" : "Create schedule"}
            </DialogTitle>
            <DialogDescription>
              Choose what this task does and when it runs.
            </DialogDescription>
          </DialogHeader>
          {renderPromptEditor({
            prompt: draft.schedule?.target.prompt,
            disabled: save.isPending || stale,
            onCancel: close,
            children: form,
          })}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ScheduleEditForm({
  draft: { schedule, recurrence: initialRecurrence },
  stale,
  save,
  onClose,
  promptEditor,
}: {
  draft: ScheduleDraft;
  stale: boolean;
  save: ReturnType<typeof useSaveSchedule>;
  onClose: () => void;
  promptEditor: PromptEditor;
}) {
  const id = useId();
  const [name, setName] = useState(schedule?.name ?? "");
  const [timing, setTiming] = useState(() =>
    scheduleTiming(
      schedule?.recurrence ??
        initialRecurrence ?? {
          kind: "cron",
          expression: "0 8 * * *",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
    ),
  );
  const [inputError, setInputError] = useState<string>();
  const timingChanged =
    !schedule ||
    JSON.stringify(timing) !==
      JSON.stringify(scheduleTiming(schedule.recurrence));
  const changed =
    !schedule ||
    name.trim() !== schedule.name ||
    timingChanged ||
    promptEditor.changed;
  const disabled = save.isPending || stale;
  return (
    <form
      className="neutral-controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !changed || !name.trim() || !promptEditor.ready) return;
        setInputError(undefined);
        try {
          const recurrence =
            schedule && !timingChanged
              ? schedule.recurrence
              : scheduleRecurrence(timing);
          save.mutate(
            {
              schedule,
              name: name.trim(),
              recurrence,
              prompt: promptEditor.read(),
            },
            { onSuccess: onClose },
          );
        } catch (error) {
          setInputError(error instanceof Error ? error.message : String(error));
        }
      }}
    >
      <FieldSet disabled={disabled} className="min-w-0">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={160}
              autoComplete="off"
            />
          </Field>
          <ScheduleTimingFields
            timing={timing}
            onChange={setTiming}
            disabled={disabled}
          />
          <Field>
            <FieldLabel>Prompt</FieldLabel>
            {promptEditor.content}
          </Field>
          {stale ? (
            <FieldError>
              This schedule changed while you were editing. Close and reopen to
              load the latest version.
            </FieldError>
          ) : inputError ? (
            <FieldError>{inputError}</FieldError>
          ) : null}
        </FieldGroup>
      </FieldSet>
      <DialogFooter className="bg-transparent pt-6">
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={disabled || !changed || !name.trim() || !promptEditor.ready}
        >
          {save.isPending ? (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          ) : null}
          {save.isPending
            ? "Saving…"
            : schedule
              ? "Save changes"
              : "Create schedule"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ScheduleTimingFields({
  timing,
  onChange,
  disabled,
}: {
  timing: ScheduleTiming;
  onChange: (timing: ScheduleTiming) => void;
  disabled: boolean;
}) {
  const id = useId();
  const [dateOpen, setDateOpen] = useState(false);
  const timeZones = useMemo(
    () =>
      [
        ...new Set([
          timing.timeZone,
          "UTC",
          ...Intl.supportedValuesOf("timeZone"),
        ]),
      ].map((value) => ({ value, label: value.replaceAll("_", " ") })),
    [timing.timeZone],
  );
  const hasTime = ["daily", "weekdays", "weekly"].includes(timing.frequency);
  const onceDate = timing.date ? new Date(`${timing.date}T00:00`) : undefined;

  return (
    <>
      <div className="flex gap-3">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor={`${id}-frequency`}>Repeat</FieldLabel>
          <Select
            value={timing.frequency}
            disabled={disabled}
            onValueChange={(value) => {
              const frequency = scheduleFrequencies.find(
                (option) => option.value === value,
              )!.value;
              onChange({ ...timing, frequency });
            }}
          >
            <SelectTrigger
              id={`${id}-frequency`}
              aria-label="Repeat"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {scheduleFrequencies.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {hasTime ? (
          <Field className="w-32 shrink-0">
            <FieldLabel htmlFor={`${id}-time`}>Time</FieldLabel>
            <Input
              id={`${id}-time`}
              type="time"
              step={60}
              required
              className={timeInputClassName}
              value={timing.time}
              onChange={(event) =>
                onChange({ ...timing, time: event.target.value })
              }
            />
          </Field>
        ) : null}
        {timing.frequency !== "once" ? (
          <Field className="min-w-0 flex-[1.5]">
            <FieldLabel htmlFor={`${id}-zone`}>Time zone</FieldLabel>
            <Combobox
              id={`${id}-zone`}
              label="Time zone"
              value={timing.timeZone}
              options={timeZones}
              disabled={disabled}
              onChange={(timeZone) => onChange({ ...timing, timeZone })}
            />
          </Field>
        ) : null}
      </div>
      {timing.frequency === "once" ? (
        <Field>
          <FieldGroup className="gap-4 sm:flex-row">
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor={`${id}-date`}>Date</FieldLabel>
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id={`${id}-date`}
                    type="button"
                    aria-label="Date"
                    variant="outline"
                    disabled={disabled}
                    className="w-full justify-between font-normal"
                  >
                    {onceDate
                      ? onceDate.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "Select date"}
                    <ChevronDownIcon />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="neutral-controls w-auto overflow-hidden p-0"
                  align="start"
                >
                  <Suspense
                    fallback={
                      <p className="p-4 text-sm text-muted-foreground">
                        Loading calendar…
                      </p>
                    }
                  >
                    <Calendar
                      mode="single"
                      selected={onceDate}
                      defaultMonth={onceDate}
                      onSelect={(date) => {
                        if (date)
                          onChange({
                            ...timing,
                            date: localScheduleDateTime(date).slice(0, 10),
                          });
                        setDateOpen(false);
                      }}
                    />
                  </Suspense>
                </PopoverContent>
              </Popover>
            </Field>
            <Field className="sm:w-32">
              <FieldLabel htmlFor={`${id}-once-time`}>Time</FieldLabel>
              <Input
                id={`${id}-once-time`}
                type="time"
                step={60}
                required
                className={timeInputClassName}
                value={timing.time}
                onChange={(event) =>
                  onChange({
                    ...timing,
                    time: event.target.value,
                  })
                }
              />
            </Field>
          </FieldGroup>
          <FieldDescription>
            Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
          </FieldDescription>
        </Field>
      ) : (
        <>
          {timing.frequency === "weekly" ? (
            <Field>
              <FieldLabel id={`${id}-days`}>Run on</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-labelledby={`${id}-days`}
                value={timing.day}
                disabled={disabled}
                onValueChange={(day) => {
                  if (day) onChange({ ...timing, day });
                }}
                className="w-full"
              >
                {weekdays.map(([value, label]) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    aria-label={label}
                    className="flex-1 px-0"
                  >
                    {label.slice(0, 2)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          ) : null}
          {timing.frequency === "custom" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-cron`}>Cron expression</FieldLabel>
              <Input
                id={`${id}-cron`}
                className="font-mono"
                required
                value={timing.expression}
                onChange={(event) =>
                  onChange({ ...timing, expression: event.target.value })
                }
                placeholder="*/15 9-16 * * 1-5"
                spellCheck={false}
                autoComplete="off"
                aria-describedby={`${id}-cron-help`}
              />
              <FieldDescription id={`${id}-cron-help`}>
                Minute · hour · day of month · month · day of week
              </FieldDescription>
            </Field>
          ) : null}
        </>
      )}
    </>
  );
}
