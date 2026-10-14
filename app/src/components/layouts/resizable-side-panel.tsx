// Purpose: Share a resizable desktop side panel and full-width mobile overlay.
import { forwardRef, useRef, useState, type ReactNode } from "react";

import { cn } from "@openchart/app/utils/cn";

const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;
const MAX_WIDTH = 800;

type ResizableSidePanelProps = {
  id: string;
  label: string;
  isMobile: boolean;
  hidden?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * Own local desktop width and pointer/keyboard resizing from the left edge.
 * Width starts at 400px and stays between 320–800px, capped at half the viewport.
 * Hiding preserves children and width; unmounting resets them. Mobile fills the
 * host without a resize handle. Hosts own visibility, content and focus.
 * @example <ResizableSidePanel id="details" label="Details" isMobile={isMobile}>{content}</ResizableSidePanel>
 */
export const ResizableSidePanel = forwardRef<
  HTMLElement,
  ResizableSidePanelProps
>(function ResizableSidePanel(
  { id, label, isMobile, hidden, className, children },
  ref,
) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const drag = useRef<{ pointerID: number; x: number; width: number } | null>(
    null,
  );

  function resize(width: number) {
    setWidth(
      Math.min(MAX_WIDTH, window.innerWidth / 2, Math.max(MIN_WIDTH, width)),
    );
  }

  function finishResize() {
    drag.current = null;
  }

  return (
    <aside
      ref={ref}
      id={id}
      aria-label={label}
      hidden={hidden}
      style={{ width: isMobile ? undefined : width }}
      className={cn(
        "absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l bg-background md:relative md:max-w-[50vw] md:shrink-0 [&[hidden]]:hidden",
        className,
      )}
    >
      {children}
      {isMobile ? null : (
        <button
          type="button"
          aria-label={`Resize ${label}`}
          aria-controls={id}
          title={`Drag or use Left/Right arrow keys to resize ${label}`}
          className="absolute inset-y-0 left-0 z-30 w-3 -translate-x-1/2 cursor-ew-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-sidebar-border focus-visible:after:bg-ring"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            drag.current = {
              pointerID: event.pointerId,
              x: event.clientX,
              width:
                event.currentTarget.parentElement!.getBoundingClientRect()
                  .width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = drag.current;
            if (!gesture || gesture.pointerID !== event.pointerId) return;
            resize(gesture.width + gesture.x - event.clientX);
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerID !== event.pointerId) return;
            finishResize();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const width =
              event.currentTarget.parentElement!.getBoundingClientRect().width;
            resize(width + (event.key === "ArrowLeft" ? 32 : -32));
          }}
        />
      )}
    </aside>
  );
});
