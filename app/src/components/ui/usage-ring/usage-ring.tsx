// Purpose: Ring gauge for one metered limit, with the breakdown in a hover card.
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@openchart/app/components/ui/tooltip";
import { cn } from "@openchart/app/utils/cn";

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const CRITICAL_PERCENT = 85;

export interface UsageRingRow {
  label: string;
  value: string;
}

export interface UsageRingProps {
  /** Percent used; values above 100 draw full and report as given. */
  percent: number;
  /** Names the limit in the hover card and the accessible name. */
  label: string;
  /** Rows under the bar, such as the reset time. */
  rows?: readonly UsageRingRow[];
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

/**
 * Ring filled to `percent` that turns destructive past 85%; hovering shows the
 * label, the exact percent, a bar, and the rows. Needs a TooltipProvider ancestor.
 * @example <UsageRing percent={38} label="Weekly · Fable" rows={[{ label: "Resets", value: "Sun 3:00 PM" }]} />
 */
export function UsageRing({
  percent,
  label,
  rows = [],
  side = "top",
  className,
}: UsageRingProps) {
  const drawn = Math.min(Math.max(percent, 0), 100);
  const critical = percent > CRITICAL_PERCENT;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${Math.round(percent)}% used`}
          className={cn(
            "inline-flex items-center rounded-full p-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <svg
            aria-hidden="true"
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            className="-rotate-90"
          >
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              className="stroke-muted"
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={
                RING_CIRCUMFERENCE - (drawn / 100) * RING_CIRCUMFERENCE
              }
              className={cn(
                "transition-[stroke-dashoffset,stroke] duration-300",
                critical ? "stroke-destructive" : "stroke-foreground",
              )}
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={8}
        showArrow={false}
        className="w-56 border bg-popover p-3 text-left text-popover-foreground"
      >
        <div className="text-xs">
          <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
            <span>{label}</span>
            <span
              className={cn(
                "font-mono tabular-nums",
                critical ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {Math.round(percent)}% used
            </span>
          </div>
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                drawn > 0 && "min-w-1",
                critical ? "bg-destructive" : "bg-foreground",
              )}
              style={{ width: `${drawn}%` }}
            />
          </div>
          {rows.length > 0 && (
            <div className="mt-3 grid gap-1.5">
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="flex items-baseline justify-between gap-6"
                >
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="font-mono tabular-nums">{row.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
