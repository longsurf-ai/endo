// Purpose: Render Hugeicons with shared CSS sizing, stroke, and inherited theme color.
import { HugeiconsIcon } from "@hugeicons/react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@openchart/app/utils/cn";

/** Hugeicons props with sizing and stroke delegated to CSS tokens and utilities. */
export type IconProps = Omit<
  ComponentPropsWithoutRef<typeof HugeiconsIcon>,
  "size" | "strokeWidth" | "absoluteStrokeWidth"
>;

/**
 * Render a decorative icon; the containing control supplies its accessible label.
 * Standalone meaningful icons can override aria-hidden and supply a role and label.
 * @example
 * <Icon icon={Search01Icon} className="size-icon-lg text-muted-foreground" />
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(
  ({ className, ...props }, ref) => (
    <HugeiconsIcon
      ref={ref}
      aria-hidden="true"
      focusable="false"
      {...props}
      className={cn(
        "size-icon-md shrink-0 stroke-icon-regular [&_[stroke]]:[stroke-width:inherit]",
        className,
      )}
    />
  ),
);
Icon.displayName = "Icon";
