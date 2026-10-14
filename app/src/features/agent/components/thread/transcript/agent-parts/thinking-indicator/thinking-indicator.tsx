// Streamed labels update in place so each token does not restart the entrance.
import type { ComponentProps } from "react";
import { ShimmerLabel } from "@openchart/app/components/ui/shimmer-label/shimmer-label";
import { cn } from "@openchart/app/utils/cn";

import "@assistant-ui/react-markdown/styles/dot.css";

/**
 * Renders the official thinking status line from supplied text and optional time.
 * Long labels stay on one line; the title retains the full current label.
 * @example <ThinkingIndicator label="Comparing market data" />
 */
export function ThinkingIndicator({
  label,
  elapsed,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  label: string;
  elapsed?: string;
}) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn(
        "flex min-w-0 items-center gap-2.5 text-sm text-foreground/[0.55]",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        data-status="running"
        // eslint-disable-next-line tailwindcss/no-custom-classname -- Matches the official progress dot's glyph and size.
        className="aui-md shrink-0 text-blue-500 dark:text-blue-400 [&::after]:mx-0 motion-reduce:[&::after]:animate-none"
      />
      <ShimmerLabel className="min-w-0 truncate leading-normal" title={label}>
        {label}
      </ShimmerLabel>
      {elapsed !== undefined && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums tracking-tight text-foreground/30">
          {elapsed}
        </span>
      )}
    </div>
  );
}
