// Purpose: Share read-failure feedback between schedules and their history.
import { Button } from "@openchart/app/components/ui/button";

/** Show a query failure with a caller-owned retry action. @example <ScheduleQueryError message="Couldn’t load runs." retry={retry} /> */
export function ScheduleQueryError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <p className="text-sm text-destructive">
      <Button
        variant="link"
        className="h-auto p-0 text-foreground"
        aria-label={message}
        onClick={retry}
      >
        Retry
      </Button>
    </p>
  );
}
