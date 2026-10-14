// Share quote views with Dig In.
import {
  ComposerPrimitive,
  SelectionToolbarPrimitive,
} from "@assistant-ui/react";
import { QuoteIcon, SearchIcon, XIcon, type LucideIcon } from "lucide-react";
import {
  forwardRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { readDigInSelection } from "@openchart/app/features/agent/components/dig-in/selection";

/** Official QuoteBlock presentation, with color inherited from the user bubble. @example <QuoteBlock text="Selected reply" /> */
export function QuoteBlock({
  text,
  icon: Icon = QuoteIcon,
}: {
  text: string;
  icon?: LucideIcon;
}) {
  return (
    <div data-slot="quote-block" className="mb-2 flex items-start gap-1.5">
      <Icon
        data-slot="quote-block-icon"
        className="mt-0.5 size-3 shrink-0 opacity-60"
      />
      <p
        data-slot="quote-block-text"
        className="line-clamp-2 min-w-0 text-sm italic opacity-80"
      >
        {text}
      </p>
    </div>
  );
}

/** Share upstream selection/positioning while actions stay scoped to this view. @example <SelectionToolbar threadRef={threadRef} /> */
export function SelectionToolbar({
  threadRef,
  showQuote = true,
}: {
  threadRef: RefObject<HTMLDivElement>;
  showQuote?: boolean;
}) {
  return (
    <SelectionToolbarPrimitive.Root
      asChild
      data-slot="selection-toolbar"
      role="toolbar"
      aria-label="Selected text actions"
      className="flex items-center gap-1 rounded-lg border bg-popover px-1 py-1 max-sm:!left-1/2"
    >
      <SelectionActions threadRef={threadRef} showQuote={showQuote} />
    </SelectionToolbarPrimitive.Root>
  );
}

const SelectionActions = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & {
    threadRef: RefObject<HTMLDivElement>;
    showQuote: boolean;
  }
>(({ threadRef, showQuote, ...props }, ref) => {
  const digIn = useAgentView();
  const thread = threadRef.current;
  const selection = window.getSelection();
  // Root uses a document listener and a portal. Suppress other mounted views,
  // including covered layers displaying the very same Session and Message IDs.
  if (
    !thread ||
    !selection?.rangeCount ||
    thread.closest("[inert], [hidden]") ||
    !thread.contains(selection.anchorNode) ||
    !thread.contains(selection.focusNode)
  )
    return null;
  const selected = readDigInSelection(thread);
  const enabled =
    selected &&
    digIn?.session &&
    digIn.session.kind !== "dig_in" &&
    digIn.onOpen;
  return (
    <div {...props} ref={ref}>
      {showQuote ? (
        <SelectionToolbarPrimitive.Quote
          data-slot="selection-toolbar-quote"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <QuoteIcon className="size-3.5" />
          Quote
        </SelectionToolbarPrimitive.Quote>
      ) : null}
      <button
        type="button"
        disabled={!enabled}
        onClick={() => {
          if (!enabled || !selected || !digIn?.session) return;
          const existing = [...(digIn.session.anchors ?? [])]
            .reverse()
            .find(
              (anchor) =>
                anchor.partId === selected.selection.partId &&
                anchor.startOffset === selected.selection.startOffset &&
                anchor.endOffset === selected.selection.endOffset,
            );
          digIn.onOpen?.({
            kind: "dig-in",
            input: {
              sessionID: digIn.session.id,
              messageID: selected.messageID,
              selection: selected.selection,
            },
            childSessionID: existing?.childSessionId,
            model: digIn.model,
            workspaceId: digIn.workspaceId,
          });
          window.getSelection()?.removeAllRanges();
        }}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <SearchIcon className="size-3.5" />
        Dig in
      </button>
    </div>
  );
});
SelectionActions.displayName = "SelectionActions";

/** Same preview surface for composer quotes and local Dig In context. @example <QuotePreview text={text} icon={SearchIcon} /> */
export function QuotePreview({
  text,
  icon: Icon = QuoteIcon,
  dismiss,
}: {
  text: ReactNode;
  icon?: LucideIcon;
  dismiss?: ReactNode;
}) {
  return (
    <div
      data-slot="composer-quote"
      className="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2"
    >
      <Icon
        data-slot="composer-quote-icon"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
      />
      <div
        data-slot="composer-quote-text"
        className="line-clamp-2 min-w-0 flex-1 text-sm text-muted-foreground"
      >
        {text}
      </div>
      {dismiss}
    </div>
  );
}

/** Preview and dismiss the quote owned by assistant-ui. @example <ComposerQuotePreview /> */
export function ComposerQuotePreview() {
  return (
    <ComposerPrimitive.Quote>
      <QuotePreview
        text={<ComposerPrimitive.QuoteText />}
        dismiss={
          <ComposerPrimitive.QuoteDismiss
            data-slot="composer-quote-dismiss"
            aria-label="Dismiss quote"
            className="shrink-0 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" />
          </ComposerPrimitive.QuoteDismiss>
        }
      />
    </ComposerPrimitive.Quote>
  );
}
