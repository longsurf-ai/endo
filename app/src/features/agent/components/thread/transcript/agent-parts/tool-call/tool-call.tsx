"use client";

import type { ReactNode } from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@openchart/app/components/ui/collapsible/collapsible";
import { cn } from "@openchart/app/utils/cn";
import { ShimmerLabel } from "@openchart/app/components/ui/shimmer-label/shimmer-label";
import { SwapLabel } from "@openchart/app/components/ui/swap-label/swap-label";

/** Official tool-call disclosure, with an optional outcome icon and extra details. */
export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  className?: string;
  statusIcon?: ReactNode;
  children?: ReactNode;
}

/**
 * Render tool data and extra details in one disclosure; Collapsible owns its open state.
 * @example <ToolCall label="Searched docs" activeLabel="Searching docs" query="charts" request="{}" result="Found" running={false} />
 */
export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  className,
  statusIcon,
  children,
}: ToolCallProps) {
  return (
    <Collapsible
      data-slot="tool-call"
      data-aui-quote-selectable="false"
      className={cn("w-full min-w-0 max-w-sm", className)}
    >
      <CollapsibleTrigger className="group/trigger flex max-w-full items-center gap-2 rounded-md py-1 text-[13.5px] text-foreground/[0.55] outline-none transition-colors hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] group-data-[open]/trigger:rotate-90 group-data-[panel-open]/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel
          active={running ? 0 : 1}
          className="min-w-0 shrink-0 text-start"
        >
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        {query && (
          <span
            title={query}
            className="min-w-0 truncate rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] tracking-tight text-foreground/70"
          >
            {query}
          </span>
        )}
        <span className="ms-auto flex w-4 shrink-0 items-center justify-end">
          {statusIcon ??
            (!running && (
              <CheckIcon className="size-3.5 text-emerald-500 duration-200 animate-in fade-in zoom-in-90 motion-reduce:animate-none" />
            ))}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden outline-none">
        <div className="mt-2 overflow-hidden rounded-2xl bg-foreground/[0.04] text-xs dark:bg-foreground/[0.06]">
          <div className="px-3.5 pb-2 pt-2.5">
            <p className="mb-1 font-mono text-[11px] tracking-tight text-foreground/[0.35]">
              Request
            </p>
            <p className="whitespace-pre-wrap font-mono text-foreground/[0.55] [overflow-wrap:anywhere]">
              {request}
            </p>
          </div>
          <div className="mx-3.5 h-px bg-foreground/[0.06]" />
          <div className="px-3.5 pb-2.5 pt-2">
            <p className="mb-1 font-mono text-[11px] tracking-tight text-foreground/[0.35]">
              Result
            </p>
            <p className="whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
              {result}
            </p>
          </div>
        </div>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
