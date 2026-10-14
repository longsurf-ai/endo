// Purpose: Tooltip appearance using Radix positioning and accessibility.
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@openchart/app/utils/cn";

/**
 * Compose the Radix TooltipProvider primitive with caller-provided content and props.
 * @example
 * <TooltipProvider />
 */
const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Compose the Radix Tooltip primitive with caller-provided content and props.
 * @example
 * <Tooltip />
 */
const Tooltip = TooltipPrimitive.Root;

/**
 * Compose the Radix TooltipTrigger primitive with caller-provided content and props.
 * @example
 * <TooltipTrigger />
 */
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Compose the Radix TooltipContent primitive with caller-provided content and props.
 * @example
 * <TooltipContent />
 */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    showArrow?: boolean;
  }
>(
  (
    { className, sideOffset = 0, showArrow = true, children, ...props },
    ref,
  ) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-[--radix-tooltip-content-transform-origin] text-balance rounded-md bg-foreground px-3 py-1.5 text-xs text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      >
        {children}
        {showArrow && (
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-xs bg-foreground fill-foreground" />
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
