// Purpose: Expose proactive suggestions to the app.
import { trpc } from "@openchart/server/lib/trpc";

import { listPromptSuggestions } from "./proactive";

/** Read-only Proactive procedures. */
export const proactiveRouter = trpc.router({
  /** Prompts offered beneath an empty chat, best first. */
  promptSuggestions: trpc.procedure.query(() => listPromptSuggestions()),
});
