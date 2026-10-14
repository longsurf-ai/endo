"use client";

import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { Avatar } from "@base-ui/react/avatar";
import { cn } from "@openchart/app/utils/cn";

/**
 * Official numbered citation trigger and popup, adapted to a real link.
 * The portal mounts preview content only when opened; hover state stays local
 * to the link. Closing has no delay or exit transition.
 * @example <InlineCitation href="https://example.com" preview={<Preview />}>{1}</InlineCitation>
 */
export function InlineCitation({
  preview,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"a"> & { preview: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <PreviewCard.Root open={open} onOpenChange={setOpen}>
      <PreviewCard.Trigger
        {...props}
        delay={0}
        closeDelay={0}
        className={cn(
          "mx-0.5 inline-flex h-4 min-w-4 max-w-full translate-y-[-2px] cursor-pointer items-center justify-center rounded-[5px] px-1 align-middle font-mono text-[10px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open
            ? "bg-foreground text-background"
            : "bg-foreground/[0.06] text-foreground/45 hover:text-foreground/90",
          className,
        )}
      >
        {children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="top" sideOffset={8}>
          <PreviewCard.Popup
            className={cn(
              "border border-border/60 bg-background dark:bg-popover",
              "w-64 origin-[var(--transform-origin)] rounded-2xl p-3.5 outline-none",
              "transition-[opacity,transform] duration-200 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
              "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
              "data-[ending-style]:opacity-0 data-[ending-style]:transition-none",
            )}
          >
            {preview}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/** Official source preview with an optional favicon; missing data keeps the label and initial.
 * @example <CitationSource domain="example.com" icon={null} title="Source" snippet="Page description" />
 */
export function CitationSource({
  domain,
  icon,
  title,
  snippet,
}: {
  domain: string;
  icon: string | null;
  title: string;
  snippet: string | null;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Avatar.Root className="flex size-4 shrink-0 items-center justify-center rounded bg-foreground/[0.06] text-[9px] font-medium text-foreground/45">
          <Avatar.Image
            src={icon ?? undefined}
            alt=""
            className="size-full object-contain"
          />
          <Avatar.Fallback>{domain[0]?.toUpperCase()}</Avatar.Fallback>
        </Avatar.Root>
        <span className="break-all font-mono text-[11px] tracking-tight text-foreground/40">
          {domain}
        </span>
      </div>
      <p className="mt-2 break-words text-[13px] font-medium leading-snug">
        {title}
      </p>
      {snippet && (
        <p className="mt-1 break-words text-[13px] leading-relaxed text-foreground/50">
          {snippet}
        </p>
      )}
    </>
  );
}
