import { forwardRef } from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@openchart/app/utils/cn";

/** Shared Base UI switch; the primitive owns checked state, keyboard input and form semantics. @example <Switch checked={advanced} onCheckedChange={setAdvanced} aria-label="Advanced mode" /> */
const Switch = forwardRef<
  HTMLElement,
  Omit<SwitchPrimitive.Root.Props, "className"> & {
    className?: string;
    size?: "sm" | "default";
  }
>(function Switch({ className, size = "default", ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      data-size={size}
      className={cn(
        "group/switch aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 peer relative inline-flex shrink-0 items-center rounded-full border border-transparent outline-none transition-all after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 data-[size=default]:h-[18.4px] data-[size=sm]:h-3.5 data-[size=default]:w-8 data-[size=sm]:w-6 data-[disabled]:cursor-not-allowed data-[checked]:bg-primary data-[unchecked]:bg-input data-[disabled]:opacity-50 motion-reduce:transition-none dark:data-[unchecked]:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-[checked]:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-[unchecked]:translate-x-0 group-data-[size=sm]/switch:data-[checked]:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-[unchecked]:translate-x-0 motion-reduce:transition-none dark:data-[checked]:bg-primary-foreground dark:data-[unchecked]:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
});

export { Switch };
