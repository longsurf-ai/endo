"use client";

import type { ComponentProps } from "react";
import { CheckIcon, Loader2Icon, TerminalIcon, XIcon } from "lucide-react";
import { cn } from "@openchart/app/utils/cn";

const paper = "bg-background border border-border/60 dark:bg-popover";
const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]";
const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none";

/** Display states controlled by the caller, never inferred from a click. */
export type ApprovalState = "request" | "running" | "done" | "denied";

/**
 * Approval card; callers own decisions and execution state.
 * Disabled controls prevent replies while a request is loading or being submitted.
 * @example <ApprovalCard state="request" title="Allow echo?" subtitle="The agent requests approval." command="hello" onAllowOnce={approve} />
 */
export function ApprovalCard({
  state,
  command,
  requestDetails,
  title,
  subtitle,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  className,
  disabled = false,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "state"
  | "command"
  | "requestDetails"
  | "title"
  | "subtitle"
  | "onAllowOnce"
  | "onAlwaysAllow"
  | "onDeny"
> & {
  state: ApprovalState;
  command: string;
  requestDetails?: string;
  title: string;
  subtitle: string;
  onAllowOnce?: () => void;
  onAlwaysAllow?: () => void;
  onDeny?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      data-slot="approval-card"
      className={cn(
        paper,
        "flex max-h-[60dvh] w-full min-w-0 max-w-sm flex-col gap-3.5 rounded-[20px] p-4",
        className,
      )}

      {...props}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.05] text-foreground/[0.45]">
          <TerminalIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
          <p className="text-[13.5px] font-medium">{title}</p>
          <p className="text-xs text-foreground/[0.45]">{subtitle}</p>
        </div>
      </div>

      <div className="min-h-0 min-w-0 overflow-y-auto">
        <div
          className={cn(
            field,
            "min-w-0 whitespace-pre-wrap rounded-xl px-3.5 py-2.5 font-mono text-xs text-foreground/70 [overflow-wrap:anywhere]",
          )}
        >
          {command}
        </div>
        {requestDetails && (
          <details className="mt-3 min-w-0 text-xs text-foreground/70">
            <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Request details
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
              {requestDetails}
            </pre>
          </details>
        )}
      </div>

      <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-end gap-2">
        {state === "request" ? (
          <>
            {onDeny && (
              <button
                type="button"
                disabled={disabled}
                onClick={onDeny}
                className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/[0.55] transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96]"
              >
                Deny
              </button>
            )}
            {onAlwaysAllow && (
              <button
                type="button"
                disabled={disabled}
                onClick={onAlwaysAllow}
                className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/[0.55] transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96]"
              >
                Always allow
              </button>
            )}
            {onAllowOnce && (
              <button
                type="button"
                disabled={disabled}
                onClick={onAllowOnce}
                className={cn(
                  inkButton,
                  "flex h-8 items-center rounded-full px-3.5 text-xs font-medium",
                )}
              >
                Allow once
              </button>
            )}
          </>
        ) : (
          <div
            key={state}
            className="flex items-center gap-2 text-xs text-foreground/[0.55] duration-300 animate-in fade-in"
          >
            {state === "running" ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin text-foreground/[0.45]" />
                Approved, running
              </>
            ) : state === "denied" ? (
              <>
                <XIcon className="size-3.5 text-foreground/[0.45]" />
                Denied
              </>
            ) : (
              <>
                <CheckIcon className="size-3.5 text-emerald-500" />
                Finished with exit 0
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
