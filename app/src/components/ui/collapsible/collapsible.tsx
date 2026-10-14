// Purpose: Animated collapsible disclosure on the Base UI primitive.
"use client";

import { forwardRef } from "react";
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "@openchart/app/utils/cn";

const Collapsible = forwardRef<HTMLDivElement, CollapsiblePrimitive.Root.Props>(
  (props, ref) => {
    return (
      <CollapsiblePrimitive.Root ref={ref} data-slot="collapsible" {...props} />
    );
  },
);

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  );
}

function CollapsibleContent({
  className,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      // Shared by tool disclosures and the whole-turn working trace.
      className={cn(
        "h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };

Collapsible.displayName = "Collapsible";
