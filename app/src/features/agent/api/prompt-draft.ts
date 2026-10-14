// Purpose: Restore and compile saved prompt drafts through the Agent command API.
import { useQuery } from "@tanstack/react-query";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import {
  fromPromptParts,
  toPromptParts,
  type ComposerDraft,
  type PromptParts,
} from "@openchart/app/lib/prompt-converter/converter";

/** Restore a saved prompt for editing without executing it. Unsupported Parts fail as a whole; the mounted editor owns retry and cancellation. @example const draft = usePromptDraft(transport, prompt.parts); */
export function usePromptDraft(transport: AppTransport, parts: PromptParts) {
  return useQuery({
    // An edit snapshot is independent of live Agent directory invalidation.
    queryKey: [["agent", "promptDraft"], transport.url, parts],
    queryFn: ({ signal }) =>
      fromPromptParts(parts, (part) =>
        transport.rpc.agent.restoreCommand.mutate(part, { signal }),
      ),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/** Compile a prepared draft without submitting it. Command failures reject so the host can retain its draft. @example const parts = await buildPromptParts(transport, draft); */
export function buildPromptParts(
  transport: AppTransport,
  draft: ComposerDraft,
) {
  return toPromptParts(draft, (input) =>
    transport.rpc.agent.buildCommand.mutate(input),
  );
}
