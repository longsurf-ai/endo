// Purpose: Share Layout-owned Copilot visibility and Session selection with routed pages.
import { PanelRightIcon } from "lucide-react";
import { createContext, useContext } from "react";

import { Button } from "@openchart/app/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@openchart/app/components/ui/tooltip";

type CopilotControls = {
  open: boolean;
  toggle: () => void;
  selectSession: (sessionID: string) => void;
  /** Reveal the current conversation and add an unsent creation prompt. */
  prefill: (text: string) => void;
} | null;

/** One explicit UI request; assistant-ui continues to own the editable draft. */
export type CopilotPrefill = { readonly text: string };

const CopilotControlsContext = createContext<CopilotControls | undefined>(
  undefined,
);

/**
 * Shares Layout's controls without owning state; null disables Copilot on the current route.
 * @example <CopilotControlsProvider value={controls}>{children}</CopilotControlsProvider>
 */
export const CopilotControlsProvider = CopilotControlsContext.Provider;

/**
 * Toggles Layout's Copilot; renders nothing when unavailable and throws without its provider.
 * @example <CopilotTrigger />
 */
export function CopilotTrigger() {
  const controls = useCopilotControls();
  if (controls === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={controls.open ? "secondary" : "ghost"}
          size="icon-sm"
          className="rounded-md"
          aria-label="Toggle Copilot"
          aria-expanded={controls.open}
          aria-controls="app-copilot"
          onClick={controls.toggle}
        >
          <PanelRightIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Toggle Copilot</TooltipContent>
    </Tooltip>
  );
}

/** Read Layout's controls; null means this route has no Copilot. Throws outside the provider. @example const copilot = useCopilotControls(); copilot?.selectSession(sessionID); */
export function useCopilotControls() {
  const controls = useContext(CopilotControlsContext);
  if (controls === undefined) {
    throw new Error("useCopilotControls requires CopilotControlsProvider");
  }
  return controls;
}
