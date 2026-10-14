// Purpose: Compact settings switch on the existing Radix interaction owner.
// Checked track uses the same neutral foreground/background pair as Agent transcript controls.
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Loader2 } from "lucide-react";
import * as React from "react";

import { cn } from "@openchart/app/utils/cn";

type SwitchProps = React.ComponentPropsWithoutRef<
  typeof SwitchPrimitive.Root
> & { loading?: boolean };

/** Settings switch; loading disables keyboard and pointer changes while keeping its state visible. @example <Switch checked={enabled} loading={isSaving} onCheckedChange={save} /> */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ loading, disabled, className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    aria-busy={loading || undefined}
    disabled={disabled || loading}
    className={cn(
      "peer relative inline-flex h-[18px] w-[2.125rem] shrink-0 cursor-pointer items-center rounded-full border shadow-xs outline-none transition-all focus-visible:border-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-input",
      loading && "pointer-events-none w-[1.125rem]",
      className,
    )}
    {...props}
  >
    {loading && (
      <div className="absolute inset-0 left-1/2 top-1/2 z-10 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center">
        <Loader2
          className="animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      </div>
    )}
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className="pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%)] data-[state=unchecked]:translate-x-0"
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
