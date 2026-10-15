// Purpose: Confirm scoped removal and retain the target and open drafts on failure.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@openchart/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@openchart/app/components/ui/dialog";
import {
  useForgetWorkspace,
  useWorkspaceFileMutations,
  workspaceFileQueryOptions,
} from "@openchart/app/lib/workspace/workspace";
import { useWorkspaceView } from "./context";

function RemovalConfirmation({
  title,
  description,
  action,
  pending,
  disabled = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description: ReactNode;
  action: string;
  pending: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || disabled}
            onClick={onConfirm}
          >
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Read the targeted file only when confirming deletion; honor readOnly and delete with its content hash. Failure keeps the dialog and drafts. @example <DeleteFileDialog workspaceId={id} path={path} onDeleted={closeFile} onClose={closeDialog} /> */
export function DeleteFileDialog({
  workspaceId,
  path,
  onDeleted,
  onClose,
}: {
  workspaceId: string;
  path: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const { transport } = useWorkspaceView();
  const { remove } = useWorkspaceFileMutations(
    transport,
    workspaceId,
    onDeleted,
  );
  const query = useQuery({
    ...workspaceFileQueryOptions(transport, workspaceId, path),
    enabled: !remove.isPending,
  });
  return (
    <RemovalConfirmation
      title="Delete file?"
      description={
        <>
          Permanently delete <span className="break-all">{path}</span>? Its open
          tab and unsaved changes in this view will be discarded.
        </>
      }
      action="Delete file"
      pending={remove.isPending}
      disabled={!query.isSuccess || query.isFetching || query.data.readOnly}
      onClose={onClose}
      onConfirm={() => {
        if (query.isSuccess && !query.data.readOnly)
          remove.mutate({ path, expected: query.data.entry.hash });
      }}
    >
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading file…
        </p>
      ) : null}
      {query.data?.readOnly ? (
        <p className="text-sm text-muted-foreground">
          Built-in files are read-only.
        </p>
      ) : null}
      {query.isError ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      ) : null}
    </RemovalConfirmation>
  );
}

/** Permanently delete a folder and everything in it; built-in originals refuse. Failure keeps the dialog and drafts. @example <DeleteFolderDialog workspaceId={id} path="notes" onDeleted={closeTabs} onClose={closeDialog} /> */
export function DeleteFolderDialog({
  workspaceId,
  path,
  onDeleted,
  onClose,
}: {
  workspaceId: string;
  path: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const { transport } = useWorkspaceView();
  const { removeDirectory } = useWorkspaceFileMutations(
    transport,
    workspaceId,
    onDeleted,
  );
  return (
    <RemovalConfirmation
      title="Delete folder?"
      description={
        <>
          Permanently delete <span className="break-all">{path}</span> and
          everything in it? Open tabs inside it and their unsaved changes in
          this view will be discarded.
        </>
      }
      action="Delete folder"
      pending={removeDirectory.isPending}
      onClose={onClose}
      onConfirm={() => removeDirectory.mutate(path)}
    />
  );
}

/** Forget only the registration, keeping disk files; release matching view tabs on success before refreshing queries. @example <ForgetWorkspaceDialog workspaceId={id} root={root} onForgot={closeTabs} onClose={closeDialog} /> */
export function ForgetWorkspaceDialog({
  workspaceId,
  root,
  onForgot,
  onClose,
}: {
  workspaceId: string;
  root: string;
  onForgot: () => void;
  onClose: () => void;
}) {
  const { transport } = useWorkspaceView();
  const forget = useForgetWorkspace(transport, onForgot);
  return (
    <RemovalConfirmation
      title="Forget workspace?"
      description={
        <>
          Remove <span className="break-all">{root}</span> from Endo? Files on
          disk will be kept. Its open tabs and unsaved changes in this view will
          be discarded.
        </>
      }
      action="Forget workspace"
      pending={forget.isPending}
      onClose={onClose}
      onConfirm={() => forget.mutate(workspaceId)}
    />
  );
}
