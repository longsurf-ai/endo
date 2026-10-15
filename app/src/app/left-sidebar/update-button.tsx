// Purpose: Offer a downloaded desktop update from the sidebar instead of interrupting with a dialog.
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@openchart/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@openchart/app/components/ui/tooltip";
import { useAppHost } from "@openchart/app/lib/host/host";

/**
 * The release Desktop has downloaded and is ready to install, or undefined
 * until it announces one; subscribes while mounted.
 * @example const release = useUpdateReady();
 */
export function useUpdateReady() {
  const { onUpdateReady } = useAppHost();
  const [release, setRelease] = useState<string>();
  useEffect(() => onUpdateReady(setRelease), [onUpdateReady]);
  return release;
}

/**
 * Requests a normal quit to install Desktop's downloaded release. Editors may
 * cancel; failed requests appear in a toast. Owns no update state or subscriptions.
 * @example <UpdateButton release="Endo 0.1.1" />
 */
export function UpdateButton({ release }: { release: string }) {
  const { restartToUpdate } = useAppHost();
  const label = `Restart to install ${release}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          aria-label={label}
          variant="ghost"
          onClick={() => {
            restartToUpdate().catch((error: unknown) =>
              toast.error("Couldn’t restart to update", {
                description:
                  error instanceof Error ? error.message : String(error),
              }),
            );
          }}
        >
          <Download className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
