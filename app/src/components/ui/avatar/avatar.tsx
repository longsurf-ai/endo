import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { cn } from "@openchart/app/utils/cn";

/** Base UI Avatar root using the application's theme. @example <Avatar><AvatarFallback>OC</AvatarFallback></Avatar> */
export function Avatar({
  className,
  ...props
}: Omit<AvatarPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 select-none overflow-hidden rounded-full",
        className,
      )}
      {...props}
    />
  );
}

/** Base UI image loading/error state drives AvatarFallback. @example <AvatarImage src={logo} alt="" /> */
export function AvatarImage({
  className,
  ...props
}: Omit<AvatarPrimitive.Image.Props, "className"> & { className?: string }) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("size-full object-contain", className)}
      {...props}
    />
  );
}

/** Fallback initials when no author image is supplied. @example <AvatarFallback>OC</AvatarFallback> */
export function AvatarFallback({
  className,
  ...props
}: Omit<AvatarPrimitive.Fallback.Props, "className"> & { className?: string }) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
