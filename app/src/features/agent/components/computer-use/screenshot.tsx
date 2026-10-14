// Purpose: Show complete tool images with the shared accessible image dialog.
import { useState } from "react";
import { ImageOffIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@openchart/app/components/ui/dialog";
import { cn } from "@openchart/app/utils/cn";

/** Image failures stay visible instead of leaving an empty preview. */
export function Screenshot({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  return failedSource === src ? (
    <div
      role="status"
      className="flex min-h-32 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
    >
      <ImageOffIcon className="size-5" />
      Screenshot unavailable
    </div>
  ) : (
    <img
      src={src}
      alt="Computer screenshot"
      draggable={false}
      className={cn("block size-full object-contain", className)}
      onError={() => setFailedSource(src)}
    />
  );
}

/** Reuse Radix focus/escape behavior for both inline and floating previews. */
export function ScreenshotPreview({
  src,
  children,
}: {
  src: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="gap-3 p-3 sm:max-w-[90vw] lg:max-w-[90vw] xl:max-w-[90vw]"
      >
        <DialogTitle className="pr-8 text-sm">Computer screenshot</DialogTitle>
        <Screenshot src={src} className="max-h-[75dvh]" />
      </DialogContent>
    </Dialog>
  );
}
