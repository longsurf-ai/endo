// Purpose: Share a compact, persistent status strip without feature-specific behavior.
import type { ComponentProps, ReactNode } from "react";
import { Alert, AlertTitle } from "@openchart/app/components/ui/alert";
import { cn } from "@openchart/app/utils/cn";

// Red text is dark-mode-only to preserve contrast on the tinted surface.
const tones = {
  neutral: "bg-muted/40 text-muted-foreground",
  warning:
    "border-indicator-amber/30 bg-indicator-amber/10 text-foreground [&>svg]:text-indicator-amber",
  danger:
    "border-destructive/30 bg-destructive/10 text-foreground dark:text-destructive [&>svg]:text-destructive",
} as const;

/**
 * A polite status strip with caller-owned content, icon and actions. Actions wrap
 * in narrow panels; tones use the app theme. Callers own visibility and behavior.
 * @example <StatusBanner tone="warning" action={<Button>Retry</Button>}>Disconnected</StatusBanner>
 */
export function StatusBanner({
  tone = "neutral",
  icon,
  action,
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  tone?: keyof typeof tones;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Alert
      role="status"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-none border-x-0 border-t-0 py-2 [&>svg]:shrink-0 [&>svg]:translate-y-0",
        tones[tone],
        className,
      )}
      {...props}
    >
      {icon}
      <AlertTitle className="line-clamp-none min-w-0 flex-1 basis-40">
        {children}
      </AlertTitle>
      {action ? (
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {action}
        </div>
      ) : null}
    </Alert>
  );
}
