// Purpose: Render the loading indicator without application state.
import { Loader2 } from "lucide-react";

import { cn } from "@openchart/app/utils/cn";

const sizes = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-16 w-16",
  xl: "h-24 w-24",
};

const variants = {
  light: "text-white",
  primary: "text-slate-600",
};

export type SpinnerProps = {
  size?: keyof typeof sizes;
  variant?: keyof typeof variants;
  className?: string;
  label?: string;
};

/**
 * Show a loading glyph while retaining a screen-reader label.
 * @example
 * <Spinner size="sm" className="text-current" />
 */
export const Spinner = ({
  size = "md",
  variant = "primary",
  className = "",
  label = "Loading",
}: SpinnerProps) => {
  return (
    <>
      <Loader2
        aria-hidden="true"
        className={cn(
          "shrink-0 animate-spin motion-reduce:animate-none",
          sizes[size],
          variants[variant],
          className,
        )}
      />
      <span className="sr-only" role="status" aria-label={label}>
        {label}
      </span>
    </>
  );
};
