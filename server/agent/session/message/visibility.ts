// Purpose: Owns protocol-independent display visibility for Agent transcript facts.

import type { Part } from "@openchart/server/agent/contracts/part";

/**
 * Whether a text Part belongs in the user-visible transcript.
 * Synthetic text remains available for model replay.
 * @example
 * const visible = parts.filter(visibleTextPart);
 */
export function visibleTextPart(part: Part): boolean {
  return part.type === "text" && !part.synthetic;
}
