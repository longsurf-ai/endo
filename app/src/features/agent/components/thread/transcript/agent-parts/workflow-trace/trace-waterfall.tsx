"use client";

import { useState, type ComponentProps } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@openchart/app/components/ui/collapsible/collapsible";
import { cn } from "@openchart/app/utils/cn";

const mono = "font-mono text-[11px] tracking-tight";
const paper = "bg-background border border-border/60 dark:bg-popover";
const pct = (value: number, total: number) => (value / total) * 100;

function formatDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const remainingSeconds = `${String(seconds % 60).padStart(2, "0")}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${remainingSeconds}`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m${remainingSeconds}`;
}

export type SpanStatus = "running" | "completed" | "failed" | "cancelled";

export interface TraceSpan {
  id: string;
  name: string;
  isAgent: boolean;
  depth: number;
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  onActivate?: () => void;
}

export interface TraceRow {
  kind: "row";
  id: string;
  spans: [TraceSpan, ...TraceSpan[]];
}

export interface TracePhase {
  kind: "phase";
  id: string;
  span: TraceSpan;
  entries: TraceEntry[];
}

export type TraceEntry = TraceRow | TracePhase;

const TONE: Record<SpanStatus, string> = {
  running: "bg-blue-500 dark:bg-blue-400",
  completed: "bg-foreground/[0.35]",
  failed: "bg-red-500/80",
  cancelled: "bg-foreground/20",
};

/** Render grouped Elements spans with individual activation and summed row durations. @example <TraceWaterfall entries={entries} totalMs={1000} /> */
export function TraceWaterfall({
  entries,
  totalMs,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  entries: readonly TraceEntry[];
  totalMs: number;
}) {
  return (
    <div
      data-slot="trace-waterfall"
      className={cn(
        paper,
        "flex w-full max-w-md flex-col gap-2 rounded-2xl p-4",
        className,
      )}
      {...props}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">Workflow</span>
        <span className={cn(mono, "tabular-nums text-foreground/[0.35]")}>
          {formatDuration(totalMs)}
        </span>
      </div>

      <WaterfallEntries entries={entries} totalMs={totalMs} />
    </div>
  );
}

function WaterfallEntries({
  entries,
  totalMs,
}: {
  entries: readonly TraceEntry[];
  totalMs: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      {entries.map((entry) =>
        entry.kind === "phase" ? (
          <PhaseSection key={entry.id} phase={entry} totalMs={totalMs} />
        ) : (
          <WaterfallRow key={entry.id} row={entry} totalMs={totalMs} />
        ),
      )}
    </div>
  );
}

function WaterfallRow({ row, totalMs }: { row: TraceRow; totalMs: number }) {
  const first = row.spans[0];
  const span = totalMs || 1;
  const durationMs = row.spans.reduce(
    (total, item) => total + item.durationMs,
    0,
  );
  return (
    <div
      role="group"
      aria-label={first.name}
      className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_4rem] items-center gap-2 text-start duration-300 animate-in fade-in slide-in-from-left-1 fill-mode-both motion-reduce:animate-none"
    >
      <span
        className="min-w-0 truncate text-xs text-foreground/70"
        title={first.name}
        style={{
          paddingInlineStart: `${first.depth * 1.5}rem`,
        }}
      >
        {first.name}
      </span>
      <div className="relative h-4 min-w-0">
        {row.spans.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.onActivate}
            onClick={item.onActivate}
            aria-label={`Open ${item.name}`}
            title={`${item.name} · ${formatDuration(item.durationMs)}`}
            className="absolute flex h-4 items-center rounded-sm outline-none transition-[inset-inline-start,width] [transition-duration:100ms] [transition-timing-function:linear] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring enabled:hover:bg-foreground/[0.08] motion-reduce:transition-none"
            style={{
              insetInlineStart: `${pct(item.startMs, span)}%`,
              width: `${Math.max(1.5, pct(item.durationMs, span))}%`,
            }}
          >
            <span
              role="img"
              aria-label={`${item.status}, starts at ${item.startMs}ms, runs ${item.durationMs}ms`}
              className={cn(
                "h-[7px] w-full rounded-full",
                !item.isAgent &&
                  (item.status === "running" || item.status === "completed")
                  ? "bg-[var(--workflow-control)]"
                  : TONE[item.status],
                item.status === "running" &&
                  "animate-pulse motion-reduce:animate-none",
              )}
            />
          </button>
        ))}
      </div>
      <span className={cn(mono, "text-end tabular-nums text-foreground/30")}>
        {formatDuration(durationMs)}
      </span>
    </div>
  );
}

function agentCalls(entries: readonly TraceEntry[]): TraceSpan[] {
  return entries.flatMap((entry) =>
    entry.kind === "phase"
      ? agentCalls(entry.entries)
      : entry.spans.filter((span) => span.isAgent),
  );
}

const STATUS: Record<SpanStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function PhaseSection({
  phase,
  totalMs,
}: {
  phase: TracePhase;
  totalMs: number;
}) {
  const [userOpen, setUserOpen] = useState<boolean>();
  const calls = agentCalls(phase.entries);
  const completed = calls.filter((call) => call.status === "completed").length;
  const failed = calls.filter((call) => call.status === "failed").length;
  const cancelled = calls.filter((call) => call.status === "cancelled").length;
  const open =
    userOpen ??
    (phase.span.status !== "completed" || failed > 0 || cancelled > 0);
  return (
    <Collapsible
      open={open}
      onOpenChange={setUserOpen}
      className="min-w-0 rounded-md transition-colors hover:bg-muted/50 motion-reduce:transition-none"
    >
      <CollapsibleTrigger
        aria-label={`${phase.span.name} phase`}
        className="group/trigger flex w-full min-w-0 items-start gap-1.5 rounded-md py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ paddingInlineStart: `${phase.span.depth * 1.5}rem` }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[open]/trigger:rotate-90 group-data-[panel-open]/trigger:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-xs font-medium"
            title={phase.span.name}
          >
            {phase.span.name}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
            <span>{STATUS[phase.span.status]}</span>
            {calls.length > 0 && (
              <span>
                {completed}/{calls.length} calls completed
              </span>
            )}
            {failed > 0 && (
              <span className="text-destructive">{failed} failed</span>
            )}
            {cancelled > 0 && <span>{cancelled} cancelled</span>}
          </span>
        </span>
        <span
          className={cn(mono, "shrink-0 tabular-nums text-muted-foreground")}
        >
          {formatDuration(phase.span.durationMs)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-2">
          <WaterfallEntries entries={phase.entries} totalMs={totalMs} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
