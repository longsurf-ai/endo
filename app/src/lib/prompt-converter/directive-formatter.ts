// Purpose: Adapts shared directive syntax to assistant-ui's formatter contract.
import type { Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { directiveFormatter as sharedFormatter } from "@openchart/agent/directive-formatter";

export { readLeadingDirective } from "@openchart/agent/directive-formatter";

/** Shared lossless chip formatter used by composer and transcript. */
export const directiveFormatter: Unstable_DirectiveFormatter = sharedFormatter;
