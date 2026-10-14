// Purpose: Show compaction progress and a permanent boundary using existing UI primitives.
import { TextSelectIcon } from "lucide-react";
import { Separator } from "@openchart/app/components/ui/separator/separator";
import { ThinkingIndicator } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/thinking-indicator/thinking-indicator";

/** Render the committed boundary outside work disclosures. @example <CompactionMarker status="complete" /> */
export function CompactionMarker({
  status,
}: {
  status: "running" | "complete" | "incomplete";
}) {
  return (
    <div
      data-aui-quote-selectable="false"
      className="mx-auto my-6 w-full max-w-3xl"
    >
      <Separator className="mb-5" />
      {status === "running" ? (
        <ThinkingIndicator label="Compacting…" role="status" />
      ) : (
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <TextSelectIcon aria-hidden="true" className="size-4 shrink-0" />
          <span>
            {status === "complete"
              ? "Context compacted"
              : "Context compaction incomplete"}
          </span>
        </div>
      )}
    </div>
  );
}
