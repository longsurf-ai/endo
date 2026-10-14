"use client";
import { toast } from "sonner";
// Purpose: Show a titled code block with a copy button.

import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@openchart/app/utils/cn";

export interface CodeBlockProps extends Omit<
  ComponentProps<"figure">,
  "title"
> {
  /** Label in the header, usually the file name. */
  title?: ReactNode;
  /** Classes for the scrollable code region, e.g. a max height. */
  viewportClassName?: string;
  /** Text for the copy button; defaults to the rendered code's text. */
  copyText?: string;
  /** Called after the copy button writes the clipboard. */
  onCopied?: () => void;
  /** Numbers the lines when the `pre` does not carry `data-line-numbers` itself. */
  lineNumbers?: boolean;
}

function CopyButton({
  getText,
  onCopied,
  className,
}: {
  getText: () => string;
  onCopied?: (() => void) | undefined;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Copy code"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(getText());
          } catch {
            toast.error("Couldn’t copy to clipboard");
            return;
          }
          onCopied?.();
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        {copied ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </>
  );
}

/**
 * Chrome for highlighted code: a hairline field panel with an optional title
 * header and a copy button. Children carry the `pre` element; tokens read
 * shiki's inline colors or `--shiki-light`, and in dark mode fall back to
 * `--shiki-dark`. Lines render as blocks on a `w-max` surface so
 * highlighted rows paint past the scroll fold, and `data-line-numbers` on the
 * `pre` (or the `lineNumbers` prop) turns on a CSS counter gutter.
 */
export function CodeBlock({
  title,
  viewportClassName,
  copyText,
  onCopied,
  lineNumbers,
  className,
  children,
  ...props
}: CodeBlockProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const getText = () =>
    copyText ?? viewportRef.current?.querySelector("pre")?.textContent ?? "";

  return (
    <figure
      className={cn(
        "not-prose group/code relative my-6 flex min-w-0 flex-col overflow-hidden rounded-sm border border-foreground/10 bg-foreground/[0.025] dark:bg-foreground/[0.04]",
        className,
      )}
      {...props}
    >
      {title ? (
        <figcaption className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-foreground/10 py-0 pe-2 ps-3.5">
          <span className="min-w-0 truncate font-mono text-[11px] font-medium tracking-wide text-muted-foreground">
            {title}
          </span>
          <CopyButton getText={getText} onCopied={onCopied} />
        </figcaption>
      ) : (
        <CopyButton
          getText={getText}
          onCopied={onCopied}
          className="absolute right-2 top-2 z-10 bg-background/80 opacity-0 backdrop-blur-sm transition-opacity focus-visible:opacity-100 group-hover/code:opacity-100 [@media(pointer:coarse)]:opacity-100"
        />
      )}
      <div
        ref={viewportRef}
        role="region"
        aria-label="Code"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The scrollable code region must be keyboard-accessible.
        tabIndex={0}
        className={cn(
          "min-w-0 overflow-x-auto py-3.5 font-mono text-[12.5px] leading-relaxed [font-variant-ligatures:none] focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground/20",
          "[&_code]:!bg-transparent [&_pre]:w-max [&_pre]:min-w-full [&_pre]:!bg-transparent [&_pre]:px-3.5",
          "[&_.line]:inline-block [&_.line]:min-h-[1lh] [&_.line]:w-full",
          "[&_code_span]:[color:var(--shiki-light,inherit)]",
          "dark:[&_code_span]:![color:var(--shiki-dark)]",
          "[&_.highlighted]:bg-blue-500/[0.08] [&_.highlighted]:shadow-[inset_2px_0_0_#3b82f6] dark:[&_.highlighted]:bg-blue-500/[0.15]",
          "[&_pre[data-line-numbers]]:[counter-reset:line]",
          "[&_pre[data-line-numbers]_.line]:relative [&_pre[data-line-numbers]_.line]:pl-8 [&_pre[data-line-numbers]_.line]:[counter-increment:line]",
          "[&_pre[data-line-numbers]_.line]:before:absolute [&_pre[data-line-numbers]_.line]:before:left-0 [&_pre[data-line-numbers]_.line]:before:w-5 [&_pre[data-line-numbers]_.line]:before:text-right [&_pre[data-line-numbers]_.line]:before:tabular-nums [&_pre[data-line-numbers]_.line]:before:text-muted-foreground/40 [&_pre[data-line-numbers]_.line]:before:[content:counter(line)]",
          lineNumbers &&
            "[counter-reset:line] [&_.line]:relative [&_.line]:pl-8 [&_.line]:[counter-increment:line] [&_.line]:before:absolute [&_.line]:before:left-0 [&_.line]:before:w-5 [&_.line]:before:text-right [&_.line]:before:tabular-nums [&_.line]:before:text-muted-foreground/40 [&_.line]:before:[content:counter(line)]",
          viewportClassName,
        )}
      >
        {children}
      </div>
    </figure>
  );
}
