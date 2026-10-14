// Purpose: Shows a native provider's plan meters as usage rings beside its Settings row.
import { TooltipProvider } from "@openchart/app/components/ui/tooltip";
import {
  UsageRing,
  type UsageRingRow,
} from "@openchart/app/components/ui/usage-ring";
import type {
  ProviderQuota,
  QuotaMeter,
  QuotaWindow,
} from "@openchart/models/provider-quota";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function windowLabel(window: QuotaWindow | undefined): string {
  if (!window) return "Usage";
  if (window.kind === "month") return "Monthly";
  const { minutes } = window;
  if (minutes === MINUTES_PER_WEEK) return "Weekly";
  if (minutes === MINUTES_PER_DAY) return "Daily";
  if (minutes % MINUTES_PER_DAY === 0)
    return `${minutes / MINUTES_PER_DAY}-day`;
  if (minutes % MINUTES_PER_HOUR === 0)
    return `${minutes / MINUTES_PER_HOUR}-hour`;
  return `${minutes}-minute`;
}

function meterLabel(meter: QuotaMeter): string {
  const window = windowLabel(meter.window);
  return meter.scope.kind === "model"
    ? `${window} · ${meter.scope.name}`
    : window;
}

function meterPercent(meter: QuotaMeter): number | undefined {
  const { usage } = meter;
  if (!usage) return undefined;
  return usage.kind === "percent"
    ? usage.usedPercent
    : (usage.used / usage.limit) * 100;
}

const resetTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function meterRows(meter: QuotaMeter): UsageRingRow[] {
  const rows: UsageRingRow[] = [];
  if (meter.usage?.kind === "spend") {
    const money = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: meter.usage.currency,
    });
    rows.push({
      label: "Spent",
      value: `${money.format(meter.usage.used)} / ${money.format(meter.usage.limit)}`,
    });
  }
  if (meter.resetsAt)
    rows.push({
      label: "Resets",
      value: resetTime.format(new Date(meter.resetsAt)),
    });
  return rows;
}

/** One ring per meter with a known usage, in provider order; rows are keyed by position.
 * @example <ProviderQuotaMeters quota={quota} />
 */
export function ProviderQuotaMeters({ quota }: { quota: ProviderQuota }) {
  if (quota.status !== "ready") return null;
  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="group"
        aria-label="Plan usage"
        className="flex items-center gap-0.5"
      >
        {quota.blocked ? (
          <span className="mr-1 text-xs text-destructive">Limit reached</span>
        ) : null}
        {quota.meters.map((meter, index) => {
          const percent = meterPercent(meter);
          return percent === undefined ? null : (
            <UsageRing
              key={index}
              percent={percent}
              label={meterLabel(meter)}
              rows={meterRows(meter)}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );
}
