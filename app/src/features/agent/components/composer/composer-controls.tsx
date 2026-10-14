// Purpose: Share model and workspace controls between chat and saved-prompt editing.
import type { ModelSelection } from "@openchart/app/lib/agent/client";
import { AgentModelPicker } from "@openchart/app/features/agent/components/model-picker/model-picker";
import { WorkspacePicker } from "@openchart/app/features/agent/components/workspace-picker/workspace-picker";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

/**
 * Render controlled prompt choices and the shared model query's loading/error state.
 * Hosts own selection and initialization; retries refresh the existing Agent query.
 * @example <ComposerControls transport={transport} model={model} onModelChange={setModel} workspaceId={workspaceId} onWorkspaceChange={setWorkspaceId} disabled={pending} />
 */
export function ComposerControls({
  transport,
  model,
  onModelChange,
  workspaceId,
  onWorkspaceChange,
  disabled,
}: {
  transport: AppTransport;
  model?: ModelSelection;
  onModelChange: (model: ModelSelection) => void;
  workspaceId?: string;
  onWorkspaceChange: (workspaceId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <AgentModelPicker
        model={model}
        onChange={onModelChange}
        disabled={disabled}
      />
      <WorkspacePicker
        transport={transport}
        workspaceId={workspaceId}
        onChange={onWorkspaceChange}
        disabled={disabled}
      />
    </div>
  );
}
