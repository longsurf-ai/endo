// Purpose: Selects tool invocations presented as one native subagent.

import type { ToolPart } from "@openchart/server/agent/contracts/part";

/**
 * Selects the single child presented through native AG-UI subagent events.
 * Workflow tool visualization are done with tracing, rather than using
 * subagent lifecycle events.
 * Multiple children have no single subagent lifecycle. This only selects the
 * presentation; the full relationship set stays on ToolPart.childSessionIds.
 * @example
 * const childSessionId = toolDelegateSessionId(part);
 */
export function toolDelegateSessionId(part: ToolPart): string | undefined {
  return part.tool !== "workflow" && part.childSessionIds.length === 1
    ? part.childSessionIds[0]
    : undefined;
}
