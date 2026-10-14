import type { DataMessagePartComponent } from "@assistant-ui/react";
import { WorkflowIcon } from "lucide-react";
import { SpecSheet } from "@openchart/app/components/ui/spec-sheet/spec-sheet";
import type { UserWorkflowPart } from "@openchart/app/features/agent/ag-ui/react/assistant-ui-user-parts";
import { DirectiveChip } from "@openchart/app/features/agent/components/thread/transcript/directive-text/directive-text";
import { formatValue } from "./agent-parts/format-value";

/** Show a submitted workflow and all arguments inside the user bubble. @example <MessagePrimitive.Parts components={{ data: { by_name: { workflow: UserWorkflow } } }} /> */
export const UserWorkflow: DataMessagePartComponent<UserWorkflowPart> = ({
  data,
}) => {
  const rows = Object.entries(data.args).map(([label, value]) => ({
    label,
    value: formatValue(value),
  }));
  return (
    <SpecSheet
      role="group"
      aria-label={`Workflow: ${data.workflow}`}
      className="text-foreground"
      title={
        <DirectiveChip
          directiveType="workflow"
          directiveId={data.workflow}
          label={data.workflow}
          icon={WorkflowIcon}
        />
      }
      rows={rows}
      visibleCount={rows.length}
    />
  );
};
