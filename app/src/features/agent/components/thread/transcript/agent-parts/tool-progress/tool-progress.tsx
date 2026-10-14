import { useAuiState } from "@assistant-ui/react";

/** Keep one progress dot after non-text content while the latest run continues. @example <ToolProgress /> */
export function ToolProgress() {
  // MessagePrimitive.Parts calls Empty after non-text content as well as before
  // any content. Thinking owns the latter; the run owns gaps after tools.
  const visible = useAuiState(
    (s) => s.thread.isRunning && s.message.isLast && s.message.parts.length > 0,
  );
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-label="Working"
      data-status="running"
      // eslint-disable-next-line tailwindcss/no-custom-classname -- Reuses assistant-ui's imported dot.css.
      className="aui-md py-1.5"
    />
  );
}
