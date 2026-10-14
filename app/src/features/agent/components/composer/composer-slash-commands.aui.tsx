import { forwardRef, type ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@openchart/app/utils/cn";

interface ComposerCommand {
  name: string;
  description: string;
  argumentHint?: string;
  icon: LucideIcon;
}

const floating = "bg-background border border-border/60 dark:bg-popover";
const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]";

export const ComposerMenu = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { open: boolean; align?: "start" | "end" }
>(function ComposerMenu({ open, align = "start", className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="composer-menu"
      data-open={open || undefined}
      className={cn(
        floating,
        "absolute bottom-full z-10 mb-2 flex w-full flex-col gap-0.5 rounded-2xl p-1.5",
        align === "start"
          ? "start-0 origin-bottom-left"
          : "end-0 origin-bottom-right",
        "transition-[opacity,scale] duration-200 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        open
          ? "scale-100 opacity-100"
          : "pointer-events-none scale-[0.97] opacity-0",
        className,
      )}
      {...props}
    />
  );
});

export function ComposerMenuItem({
  active = false,
  className,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="composer-menu-item"
      data-active={active || undefined}
      className={cn(
        "flex w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] transition-colors",
        active ? field : "hover:bg-foreground/[0.04]",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerCommandItem({
  command,
  active,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  command: ComposerCommand;
  active: boolean;
}) {
  return (
    <ComposerMenuItem active={active} {...props}>
      <command.icon className="size-3.5 shrink-0 text-foreground/35" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
        <span className="flex items-center gap-2.5">
          <span className="shrink-0 font-medium">/{command.name}</span>
          <span className="truncate text-xs text-foreground/45">
            {command.description}
          </span>
        </span>
        {command.argumentHint ? (
          <span className="break-words text-xs text-muted-foreground">
            {command.argumentHint}
          </span>
        ) : null}
      </span>
      {active && (
        <kbd className="rounded bg-foreground/[0.06] px-1 font-mono text-[10px] text-foreground/45">
          ↵
        </kbd>
      )}
    </ComposerMenuItem>
  );
}
