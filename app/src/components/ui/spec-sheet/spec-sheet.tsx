"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@openchart/app/utils/cn";

/** One labeled value in the SpecSheet presentation. */
export interface SpecRow {
  label: string;
  value: string;
  emphasis?: boolean;
}

/**
 * Display a labeled object with up to visibleCount rows. The caller owns visibility;
 * counts are floored and clamped, with NaN showing no rows. This view owns no state.
 * @example <SpecSheet title="Workflow" rows={[{ label: "n", value: "3" }]} visibleCount={1} />
 */
export function SpecSheet({
  title,
  subtitle,
  rows,
  visibleCount,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "title" | "subtitle" | "rows" | "visibleCount"
> & {
  title: ReactNode;
  subtitle?: string;
  rows: readonly SpecRow[];
  visibleCount: number;
}) {
  return (
    <div
      data-slot="spec-sheet"
      className={cn(
        "border border-border/60 bg-background dark:bg-popover",
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{title}</span>
        {subtitle && (
          <span className="text-xs text-foreground/[0.45]">{subtitle}</span>
        )}
      </div>

      <div className="flex flex-col">
        {take(rows, visibleCount).map((row) => (
          <div
            key={row.label}
            className="flex items-baseline gap-3 border-t border-foreground/[0.06] py-1.5 duration-300 animate-in fade-in fill-mode-both first:border-t-0 first:pt-0 motion-reduce:animate-none"
          >
            <span
              className={cn(
                "font-mono text-[11px] tracking-tight",
                "w-24 shrink-0 text-foreground/[0.35]",
              )}
            >
              {row.label}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-end text-[13px] tabular-nums",
                row.emphasis
                  ? "font-medium text-foreground/[0.95]"
                  : "text-foreground/70",
              )}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Range helpers, kept local to this presentation component.
function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function take<T>(items: readonly T[], count: number) {
  return items.slice(0, Math.floor(clamp(count, 0, items.length)));
}
