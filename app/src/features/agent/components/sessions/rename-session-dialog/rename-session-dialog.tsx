// Purpose: Own the Session rename form and mutation feedback.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@openchart/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@openchart/app/components/ui/dialog";
import { Input } from "@openchart/app/components/ui/input";
import type { ListedSession } from "@openchart/app/lib/agent/client";
import { useAgentContext } from "@openchart/app/lib/agent/provider";

/** Rename one saved Session; the keyed form preserves its draft until closed. @example <RenameSessionDialog session={session} onClose={close} /> */
export function RenameSessionDialog({
  session,
  onClose,
}: {
  session: ListedSession;
  onClose: () => void;
}) {
  const { agent } = useAgentContext();
  const [title, setTitle] = useState(session.title);
  const rename = useMutation({
    meta: { errorTitle: "Couldn’t rename this chat" },
    mutationFn: agent.getSession(session.id).rename,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>Give this conversation a name.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim())
              rename.mutate(title.trim(), { onSuccess: onClose });
          }}
        >
          <Input
            aria-label="Chat name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || rename.isPending}>
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
