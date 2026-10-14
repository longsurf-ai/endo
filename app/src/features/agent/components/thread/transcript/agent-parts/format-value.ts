/** Format a tool result or Activity payload for display; preserve strings and error messages. @example formatValue({ count: 2 }) */
export function formatValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "");
}
