// Purpose: Route Workspace merge requests into an ordinary tier-one Copilot conversation.
import type { PropsWithChildren } from "react";
import { TIER1 } from "@openchart/models/model-tiers";
import { useCopilotControls } from "@openchart/app/app/agent/copilot-controls";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { resolveModel } from "@openchart/app/lib/agent/model-selection";
import { WorkspaceFileMerge } from "@openchart/app/lib/workspace/workspace";

/**
 * Supplies file merge admission to pages and widgets. A fresh Session preserves
 * the input and isolates merging from other work; the shared Agent owns execution.
 * Failed admission rejects so the editor retains its draft.
 * @example <WorkspaceFileMergeProvider><Outlet /></WorkspaceFileMergeProvider>
 */
export function WorkspaceFileMergeProvider({ children }: PropsWithChildren) {
  const { agent } = useAgentContext();
  const copilot = useCopilotControls();
  return (
    <WorkspaceFileMerge.Provider
      value={async (workspaceId, prompt) => {
        const model =
          agent.defaultModel &&
          resolveModel(agent.modelProviders.data ?? [], {
            providerID: agent.defaultModel.providerID,
            modelID: TIER1,
          });
        if (!model)
          throw new Error(
            "No small model is available for your selected provider. Check model settings.",
          );
        const session = await agent.createSession.mutateAsync({});
        copilot?.selectSession(session.id);
        await agent.submitPrompt.mutateAsync({
          sessionID: session.id,
          model,
          workspaceId,
          draft: { text: prompt, attachments: [], quote: undefined },
        });
      }}
    >
      {children}
    </WorkspaceFileMerge.Provider>
  );
}
