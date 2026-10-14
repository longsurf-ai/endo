// Purpose: Reuse Schedule's manual form and the current Copilot for creation.
import { useRef, type ReactNode } from "react";
import {
  CalendarPlusIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  PencilIcon,
} from "lucide-react";
import { Button } from "@openchart/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { useCopilotControls } from "@openchart/app/app/agent/copilot-controls";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { ScheduleCreateAction } from "@openchart/app/features/schedule/components/schedule-edit-dialog";
import { SchedulePromptEditor } from "./schedule-prompt-editor";

/** Keep manual form ownership in Schedule; Agent creation only prefills Copilot. @example <NewScheduleMenu transport={transport} /> */
export function NewScheduleMenu({
  transport,
  trigger,
  onManual,
}: {
  transport: AppTransport;
  trigger?: ReactNode;
  onManual?: () => void;
}) {
  const menu = (open: () => void) => (
    <ScheduleCreationMenu onManual={open} trigger={trigger} />
  );
  return onManual ? (
    menu(onManual)
  ) : (
    <ScheduleCreateAction
      transport={transport}
      renderTrigger={menu}
      renderPromptEditor={(props) => (
        <SchedulePromptEditor transport={transport} {...props} />
      )}
    />
  );
}

function ScheduleCreationMenu({
  onManual,
  trigger,
}: {
  onManual: () => void;
  trigger?: ReactNode;
}) {
  const copilot = useCopilotControls();
  const afterClose = useRef<() => void>();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Create schedule"
            title="Create schedule"
          >
            <CalendarPlusIcon aria-hidden />
            <span data-slot="page-header-action-label">Create schedule</span>
            <ChevronDownIcon aria-hidden data-slot="page-header-action-label" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="neutral-controls"
        onCloseAutoFocus={(event) => {
          const action = afterClose.current;
          if (action) event.preventDefault();
          afterClose.current = undefined;
          action?.();
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            afterClose.current = onManual;
          }}
        >
          <PencilIcon aria-hidden />
          Manual creation
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!copilot}
          onSelect={() => {
            afterClose.current = () =>
              copilot?.prefill("Create a scheduled task that...");
          }}
        >
          <MessageSquareIcon aria-hidden />
          Create with agent
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
