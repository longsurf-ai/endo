"use client";

import { Children, type ComponentProps, type ReactNode, useState } from "react";
import {
  Ban,
  CheckIcon,
  ChevronRightIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "@openchart/app/utils/cn";

export type TaskCardState =
  "working" | "waiting" | "done" | "failed" | "cancelled";

const isRenderable = (node: ReactNode) =>
  node !== undefined && node !== null && node !== false && node !== true;

function TaskStateIcon({
  state,
  className,
}: {
  state: TaskCardState;
  className?: string;
}) {
  if (state === "done") {
    return (
      <CheckIcon
        aria-hidden
        className={cn("size-3.5 shrink-0 text-emerald-500", className)}
      />
    );
  }
  if (state === "failed") {
    return (
      <XIcon
        aria-hidden
        className={cn("size-3.5 shrink-0 text-destructive", className)}
      />
    );
  }
  if (state === "cancelled") {
    return (
      <Ban
        aria-hidden
        className={cn("size-3.5 shrink-0 text-foreground/35", className)}
      />
    );
  }
  if (state === "working") {
    return (
      <Loader2Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 animate-spin text-foreground/35 motion-reduce:animate-none",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "m-1 size-1.5 shrink-0 rounded-full border border-foreground/35",
        className,
      )}
    />
  );
}

/**
 * Official task card with optional result, actions, and transcript.
 * An activation handler opens host-owned content. Otherwise, without transcript
 * children its header is inert; controlled open state without
 * a change handler also disables disclosure. No execution or navigation is owned here.
 * @example <TaskCard label="Research" state="working" />
 */
export function TaskCard({
  label,
  meta,
  state,
  elapsed,
  actions,
  result,
  open,
  onOpenChange,
  onActivate,
  children,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "label" | "state" | "result" | "open" | "onOpenChange"
> & {
  label: string;
  meta?: string | undefined;
  state: TaskCardState;
  elapsed?: string | undefined;
  actions?: ReactNode | undefined;
  result?: ReactNode | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onActivate?: () => void;
  children?: ReactNode | undefined;
}) {
  const hasTranscript = Children.toArray(children).length > 0;
  const inert = open !== undefined && onOpenChange === undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div
      data-slot="task-card"
      data-state={state}
      className={cn(
        "flex w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border/60 bg-background dark:bg-popover",
        className,
      )}
      {...props}
    >
      <button
        type="button"
        aria-expanded={!onActivate && hasTranscript ? isOpen : undefined}
        disabled={!onActivate && (!hasTranscript || inert)}
        onClick={onActivate ?? toggle}
        className="flex items-center gap-2.5 px-3.5 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:enabled:bg-foreground/[0.03] disabled:cursor-default"
      >
        <TaskStateIcon state={state} />
        <span className="sr-only">{state}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{label}</span>
        {meta !== undefined && (
          <span className="max-w-24 shrink-0 truncate font-mono text-[11px] tracking-tight text-foreground/35">
            {meta}
          </span>
        )}
        {elapsed !== undefined && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums tracking-tight text-foreground/30">
            {elapsed}
          </span>
        )}
        {(onActivate || hasTranscript) && (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-foreground/25",
              !onActivate && isOpen && "rotate-90",
            )}
          />
        )}
      </button>
      {isRenderable(actions) && (
        <div
          data-slot="task-card-actions"
          className="border-t border-border/60 px-3.5 py-2.5"
        >
          {actions}
        </div>
      )}
      {hasTranscript && isOpen && (
        <div
          data-slot="task-card-transcript"
          className="flex flex-col gap-2 border-t border-border/60 px-3.5 py-2.5"
        >
          {children}
        </div>
      )}
      {isRenderable(result) && (
        <div
          data-slot="task-card-result"
          className="border-t border-border/60 px-3.5 py-2 text-xs leading-relaxed text-foreground/70"
        >
          {result}
        </div>
      )}
    </div>
  );
}
