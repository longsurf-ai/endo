// Purpose: Own the skeleton primitive using the shared OpenChart theme.
import { cn } from "@openchart/app/utils/cn";

/**
 * Compose the Skeleton primitive with caller-provided content and props.
 * @example
 * <Skeleton />
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      {...props}
    />
  );
}

export { Skeleton };
