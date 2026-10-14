// Purpose: Connect Schedule creation and editing to Agent's shared prompt editor.
import { AgentPromptEditor } from "@openchart/app/features/agent/components/prompt-editor/prompt-editor";
import type { ScheduleEditDialogProps } from "@openchart/app/features/schedule/components/schedule-edit-dialog";
import type { PromptParts } from "@openchart/app/lib/prompt-converter/converter";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** Fill the Schedule dialog's prompt slot without owning form state or persistence. @example renderPromptEditor={(props) => <SchedulePromptEditor transport={transport} {...props} />} */
export function SchedulePromptEditor({
  transport,
  prompt,
  ...props
}: Parameters<ScheduleEditDialogProps["renderPromptEditor"]>[0] & {
  transport: AppTransport;
}) {
  return (
    <AgentPromptEditor
      {...props}
      transport={transport}
      // The output-only Resource ID brands do not change the Parts wire contract.
      prompt={
        prompt ? { ...prompt, parts: prompt.parts as PromptParts } : undefined
      }
    />
  );
}
