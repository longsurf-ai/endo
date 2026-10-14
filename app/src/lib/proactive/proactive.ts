// Purpose: Read what the backend offers the user before they ask.
import { queryOptions } from "@tanstack/react-query";

import type {
  AppTransport,
  ProactiveOutputs,
} from "@openchart/app/lib/transport/transport";

/** A prompt offered beneath an empty chat; the backend owns the copy and its order. */
export type PromptSuggestion = ProactiveOutputs["promptSuggestions"][number];

/** Prompts to suggest for a new chat, best first. @example useQuery(promptSuggestionsQueryOptions(transport)); */
export function promptSuggestionsQueryOptions(
  transport: Pick<AppTransport, "rpc" | "url">,
) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load suggestions" },
    queryKey: [["proactive", "promptSuggestions"], transport.url] as const,
    queryFn: ({ signal }) =>
      transport.rpc.proactive.promptSuggestions.query(undefined, { signal }),
  });
}
