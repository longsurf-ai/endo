// Purpose: Compose an accessible confirmation prompt and its actions.
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import * as React from "react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { useDisclosure } from "@/hooks/use-disclosure";
import { Icon } from "@openchart/app/components/ui/icon";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../dialog";

export type ConfirmationDialogProps = {
  triggerButton: React.ReactElement;
  confirmButton: React.ReactElement;
  title: string;
  body?: string;
  cancelButtonText?: string;
  icon?: "danger" | "info";
  isDone?: boolean;
  /** Prevent dismissal while the caller's confirmation is pending. */
  pending?: boolean;
};

/**
 * Confirm a caller-owned action without dismissing its pending write. The caller
 * owns failures and the draft; `isDone` closes after success, while Cancel or
 * dismissal closes only when idle. No work runs until the confirm button acts.
 * @example <ConfirmationDialog title="Remove column" triggerButton={trigger} confirmButton={remove} pending={saving} />
 */
export const ConfirmationDialog = ({
  triggerButton,
  confirmButton,
  title,
  body = "",
  cancelButtonText = "Cancel",
  icon = "danger",
  isDone = false,
  pending = false,
}: ConfirmationDialogProps) => {
  const { close, open, isOpen } = useDisclosure();
  const cancelButtonRef = React.useRef(null);

  useEffect(() => {
    if (isDone) {
      close();
    }
  }, [isDone, close]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(isOpen) => {
        if (pending) return;
        if (!isOpen) {
          close();
        } else {
          open();
        }
      }}
    >
      <DialogTrigger asChild>{triggerButton}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader className="flex">
          <DialogTitle className="flex items-center gap-2">
            {" "}
            {icon === "danger" && (
              <Icon
                icon={AlertCircleIcon}
                className="size-6 text-red-600"
                aria-hidden="true"
              />
            )}
            {icon === "info" && (
              <Icon
                icon={InformationCircleIcon}
                className="size-6 text-blue-600"
                aria-hidden="true"
              />
            )}
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left">
          {body && (
            <div className="mt-2">
              <DialogDescription className="text-foreground">
                {body}
              </DialogDescription>
            </div>
          )}
        </div>

        <DialogFooter>
          {confirmButton}
          <Button
            ref={cancelButtonRef}
            variant="outline"
            disabled={pending}
            onClick={close}
          >
            {cancelButtonText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
