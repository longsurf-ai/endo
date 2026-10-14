// Purpose: Arrange the official ChatGPT empty state and scrolling conversation around supplied slots.
import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { ChevronDownIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  LoadMore,
  type LoadMoreProps,
} from "@openchart/app/components/ui/load-more/load-more";
import type { FloatingViewerBounds } from "@openchart/app/components/ui/floating-viewer/floating-viewer";
import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";
import { cn } from "@openchart/app/utils/cn";

/** Arrange view slots without owning session state or submission. `suggestions` sits below the composer in the empty state only. @example <AgentLayout empty={empty} transcript={<AgentTranscript />} composer={<AgentComposer />} /> */
export function AgentLayout({
  empty,
  transcript,
  composer,
  suggestions,
  floating,
  history,
  children,
}: {
  empty: boolean;
  transcript: ReactNode;
  composer: ReactNode;
  suggestions?: ReactNode;
  floating?: (bounds: FloatingViewerBounds) => ReactNode;
  history?: LoadMoreProps;
  children?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ element: HTMLElement; top: number } | undefined>(
    undefined,
  );
  const firstMessageID = useAuiState((s) => s.thread.messages[0]?.id);
  const [bounds, setBounds] = useState<FloatingViewerBounds>();

  const hasMore = history?.hasMore;
  const loading = history?.loading;
  const error = history?.error;
  const onLoadMore = history?.onLoadMore;
  const loadOlder = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !hasMore || loading) return;
    const top = viewport.getBoundingClientRect().top;
    const element = [
      ...viewport.querySelectorAll<HTMLElement>("[data-transcript-message]"),
    ].find((message) => message.getBoundingClientRect().bottom > top);
    anchor.current = element
      ? { element, top: element.getBoundingClientRect().top }
      : undefined;
    onLoadMore?.();
  }, [hasMore, loading, onLoadMore]);

  useLayoutEffect(() => {
    const saved = anchor.current;
    const viewport = viewportRef.current;
    if (saved?.element.isConnected && viewport) {
      viewport.scrollTop +=
        saved.element.getBoundingClientRect().top - saved.top;
    }
    anchor.current = undefined;
  }, [firstMessageID]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const sentinel = historyRef.current;
    if (!viewport || !sentinel || !hasMore || loading || error) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadOlder();
      },
      { root: viewport, rootMargin: "80px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [empty, hasMore, loading, error, loadOlder]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const footer = footerRef.current;
    if (!floating || !viewport || !footer) return;
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      const next = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: Math.max(
          rect.top,
          Math.min(rect.bottom, footer.getBoundingClientRect().top),
        ),
      };
      setBounds((current) =>
        current?.left === next.left &&
        current.top === next.top &&
        current.right === next.right &&
        current.bottom === next.bottom
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(footer);
    viewport.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [empty, floating]);

  return empty ? (
    <div className="flex min-h-0 grow flex-col overflow-y-auto px-4">
      {/* Equal rows around the composer keep it centered; content grows away from it. */}
      <div className="mx-auto grid w-full max-w-3xl grow grid-cols-1 grid-rows-[1fr_auto_1fr] gap-6 pb-[16vh]">
        <div className="flex flex-col justify-end gap-6">
          <h1 className="text-center font-studio text-2xl font-normal leading-7">
            Where should we begin?
          </h1>
          {children}
        </div>
        {composer}
        <div>{suggestions}</div>
      </div>
    </div>
  ) : (
    <>
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className="flex min-h-0 grow flex-col overflow-y-auto px-4 pt-16"
      >
        <div ref={historyRef} className="mx-auto w-full max-w-3xl">
          {history && <LoadMore {...history} onLoadMore={loadOlder} />}
        </div>
        {transcript}
        <ThreadPrimitive.ViewportFooter
          ref={footerRef}
          className={cn(
            "sticky bottom-0 mx-auto mt-auto flex w-full max-w-3xl flex-col gap-2 overflow-visible",
            composer &&
              "bg-gradient-to-t from-background from-[calc(100%-2rem)] pb-2 pt-8",
          )}
        >
          <ThreadPrimitive.ScrollToBottom asChild>
            <TooltipIconButton
              tooltip="Scroll to latest message"
              className="absolute -top-10 z-10 self-center rounded-full border bg-background p-2 disabled:invisible dark:border-white/15 dark:bg-[#2a2a2a]"
            >
              <ChevronDownIcon className="size-5" />
            </TooltipIconButton>
          </ThreadPrimitive.ScrollToBottom>
          {children}
          {composer}
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      {bounds && floating?.(bounds)}
    </>
  );
}
