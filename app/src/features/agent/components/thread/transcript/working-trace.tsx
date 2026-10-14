import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@openchart/app/components/ui/collapsible/collapsible";

/**
 * Keeps work open while running, then folds it behind a timed label.
 * Completion resets manual toggles. Live and historical durations share message
 * timestamps; the local clock only refreshes the running display.
 * @example <WorkingTrace started running complete={false}>{work}</WorkingTrace>
 */
export function WorkingTrace({
  started,
  running,
  complete,
  createdAt,
  completedAt,
  children,
}: {
  started: boolean;
  running: boolean;
  complete: boolean;
  createdAt?: number;
  completedAt?: number;
  children: ReactNode;
}) {
  const [userOpen, setUserOpen] = useState<{
    complete: boolean;
    open: boolean;
  } | null>(null);
  const [now, setNow] = useState(Date.now);
  const timing = started && running;

  useEffect(() => {
    if (!timing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timing]);

  if (!started) return children;
  const end = running ? now : completedAt;
  const elapsed =
    createdAt !== undefined && end !== undefined && end >= createdAt
      ? Math.floor((end - createdAt) / 1000)
      : undefined;
  const duration = elapsed === undefined ? "" : ` for ${elapsed}s`;

  return (
    <Collapsible
      open={userOpen?.complete === complete ? userOpen.open : !complete}
      onOpenChange={(open) => setUserOpen({ complete, open })}
      className="mx-auto w-full min-w-0 max-w-3xl"
    >
      <CollapsibleTrigger
        data-aui-quote-selectable="false"
        className="group/trigger mb-2 flex w-full items-center gap-1.5 border-b border-border pb-3 pt-1 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-start tabular-nums">
          {running ? "Working" : "Worked"}
          {duration}
        </span>
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] group-data-[open]/trigger:rotate-90 group-data-[panel-open]/trigger:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="outline-none">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
