import {
  type PropsWithChildren,
  useState,
  type FC,
  isValidElement,
} from "react";
import {
  XIcon,
  PlusIcon,
  FileText,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@openchart/app/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@openchart/app/components/ui/dialog";
import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";
import { useAttachmentSrc } from "./use-attachment-src";
import { cn } from "@openchart/app/utils/cn";

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-opacity duration-300 motion-reduce:transition-none",
        isLoaded ? "opacity-100" : "opacity-0",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();

  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger className="cursor-zoom-in" asChild>
        {isValidElement(children) ? (
          children
        ) : (
          <button type="button">{children}</button>
        )}
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:bg-foreground/60 [&>button]:p-1 [&>button]:opacity-100 [&>button]:!ring-0 [&>button]:hover:bg-foreground/80 [&_svg]:text-background"
      >
        <DialogTitle className="sr-only">Image Attachment Preview</DialogTitle>
        <div className="relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm bg-background">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc();

  return (
    <div className="flex h-full w-full items-center justify-center">
      {src ? (
        <img
          src={src}
          alt="Attachment preview"
          className="h-full w-full object-cover"
        />
      ) : (
        <FileText className="size-6 stroke-[1.5] text-muted-foreground/80" />
      )}
    </div>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "running"
      ? "uploading"
      : s.attachment.status.type === "incomplete" &&
          s.attachment.status.reason === "error"
        ? "error"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "Upload failed")
      : undefined,
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root
          className={cn(
            "relative",
            isComposer &&
              "duration-200 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none",
            isImage && !isComposer && "[&:only-child>button]:size-24",
          )}
        >
          <AttachmentPreviewDialog>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "relative size-14 cursor-pointer overflow-hidden rounded-lg bg-muted outline-none transition-transform after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/10 after:transition-colors hover:after:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring/50 active:scale-[0.96] motion-reduce:transition-none dark:after:ring-white/10",
                  isError &&
                    "after:ring-destructive/60 dark:after:ring-destructive/60",
                )}
                aria-label={`${typeLabel} attachment${
                  isError ? ", upload failed" : isUploading ? ", uploading" : ""
                }`}
              >
                <AttachmentThumb />
                {isUploading && (
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[2px] animate-in fade-in-0 motion-reduce:animate-none"
                  >
                    <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                  </div>
                )}
                {isError && (
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px] animate-in fade-in-0 motion-reduce:animate-none"
                  >
                    <AlertCircleIcon className="size-4 text-destructive" />
                  </div>
                )}
              </button>
            </TooltipTrigger>
          </AttachmentPreviewDialog>
          {isComposer && <AttachmentRemove />}
        </AttachmentPrimitive.Root>
        <TooltipContent side="top">
          <AttachmentPrimitive.Name />
          {errorMessage && <p>{errorMessage}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="Remove file"
        size="icon-xs"
        className="absolute end-1 top-1 size-5 rounded-full !bg-black/50 text-white hover:!bg-black/70 hover:!text-white active:scale-[0.96] motion-reduce:transition-none"
        side="top"
      >
        <XIcon className="size-3 stroke-[2.5]" />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

/** Render sent attachments with the upstream preview tile. @example <UserMessageAttachments /> */
export const UserMessageAttachments: FC = () => {
  return (
    <div className="col-span-full col-start-1 row-start-1 flex w-full flex-row flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

/** Render staged attachments owned by assistant-ui. @example <ComposerAttachments /> */
export const ComposerAttachments: FC = () => {
  return (
    <div className="flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

/** Open the upstream image file picker. @example <ComposerAddAttachment /> */
export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon-sm"
        className="size-7 rounded-full text-muted-foreground hover:bg-muted-foreground/15 hover:text-foreground active:scale-[0.96] motion-reduce:transition-none dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30"
        aria-label="Add Attachment"
      >
        <PlusIcon className="size-4" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};
