// Purpose: Keep working and unread indicators mutually exclusive in chat rows.
import { Spinner } from "@openchart/app/components/ui/spinner";

/** Render working, unread, or nothing, with working taking precedence. @example <SessionIndicator isActive={session.isActive} isUnread={session.isUnread} /> */
export function SessionIndicator({
  isActive,
  isUnread,
}: {
  isActive: boolean;
  isUnread: boolean;
}) {
  if (isActive)
    return (
      <Spinner
        size="sm"
        className="!size-3 text-muted-foreground"
        label="Working"
      />
    );
  if (!isUnread) return null;
  return (
    <span
      className="flex size-3 shrink-0 items-center justify-center"
      role="status"
      aria-label="Unread"
    >
      <span
        className="size-1.5 rounded-full bg-indicator-blue"
        aria-hidden="true"
      />
    </span>
  );
}
