// Purpose: Icon button with a tooltip, composed from existing Radix controls.
import { type ComponentPropsWithRef, forwardRef } from "react";
import { Button } from "@openchart/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@openchart/app/components/ui/tooltip";
import { cn } from "@openchart/app/utils/cn";

type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};
/** Give a primitive's icon action an accessible label and tooltip. @example <TooltipIconButton tooltip="Copy"><CopyIcon /></TooltipIconButton> */
export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ children, tooltip, side = "bottom", className, ...rest }, ref) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          {...rest}
          className={cn("size-6 p-1 active:scale-90", className)}
          ref={ref}
        >
          {children}
          <span className="sr-only">{tooltip}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
));
TooltipIconButton.displayName = "TooltipIconButton";
