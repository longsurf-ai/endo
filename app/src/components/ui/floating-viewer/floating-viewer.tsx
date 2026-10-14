"use client";

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@openchart/app/utils/cn";

export type FloatingViewerCorner =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Available rectangle in viewport coordinates, supplied by the host layout. */
export type FloatingViewerBounds = Pick<
  DOMRect,
  "left" | "top" | "right" | "bottom"
>;

export interface FloatingViewerProps {
  /** Content remains mounted while the viewer moves. */
  children: ReactNode;
  /** Accessible name announced for the floating viewer. @default "Floating media viewer" */
  ariaLabel?: string;
  /** Width of the floating surface in pixels. @default 320 */
  floatingWidth?: number;
  /** Gap between the floating surface and viewport edges in pixels. @default 16 */
  viewportPadding?: number;
  /** Available host area. Defaults to the browser viewport. */
  bounds?: FloatingViewerBounds;
  /** Initial docked corner. @default "bottom-right" */
  defaultCorner?: FloatingViewerCorner;
  /** Consumer actions next to the keyboard-accessible corner cycling control. */
  controls?: ReactNode;
  /** Additional classes for the floating surface. */
  className?: string;
}

type Size = { width: number; height: number };

const corners: FloatingViewerCorner[] = [
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
];

function getCornerPosition(
  corner: FloatingViewerCorner,
  bounds: FloatingViewerBounds,
  viewer: Size,
  padding: number,
) {
  return {
    x: corner.endsWith("right")
      ? Math.max(bounds.left + padding, bounds.right - viewer.width - padding)
      : bounds.left + padding,
    y: corner.startsWith("bottom")
      ? Math.max(bounds.top + padding, bounds.bottom - viewer.height - padding)
      : bounds.top + padding,
  };
}

/**
 * Always-floating surface with free dragging and spring docking to four corners.
 * Owns viewport placement only; children and consumer actions own their behavior.
 * Resize observers, listeners and animations are released on unmount. Reduced
 * motion docks immediately. The first placement happens before paint.
 * @example <FloatingViewer ariaLabel="Reference preview">{preview}</FloatingViewer>
 */
export function FloatingViewer({
  children,
  ariaLabel = "Floating media viewer",
  floatingWidth = 320,
  viewportPadding = 16,
  bounds,
  defaultCorner = "bottom-right",
  controls,
  className,
}: FloatingViewerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const shouldReduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [corner, setCorner] = useState(defaultCorner);
  const [viewport, setViewport] = useState<FloatingViewerBounds>({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });
  const [viewer, setViewer] = useState<Size>({ width: 0, height: 0 });
  const area = bounds ?? viewport;

  const moveToCorner = useCallback(
    (nextCorner: FloatingViewerCorner, immediate = false) => {
      const target = getCornerPosition(
        nextCorner,
        area,
        viewer,
        viewportPadding,
      );
      setCorner(nextCorner);

      if (immediate || shouldReduceMotion) {
        x.set(target.x);
        y.set(target.y);
        return;
      }

      const transition = { type: "spring" as const, bounce: 0, duration: 0.4 };
      animate(x, target.x, transition);
      animate(y, target.y, transition);
    },
    [shouldReduceMotion, area, viewer, viewportPadding, x, y],
  );

  useLayoutEffect(() => {
    const updateViewport = () =>
      setViewport({
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      });
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    setViewer({ width: rect.width, height: rect.height });
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const borderSize = entry.borderBoxSize[0];
      setViewer({
        width: borderSize?.inlineSize ?? entry.contentRect.width,
        height: borderSize?.blockSize ?? entry.contentRect.height,
      });
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (area.right === area.left || viewer.width === 0) return;
    moveToCorner(corner, !placed.current);
    placed.current = true;
  }, [corner, moveToCorner, viewer.width, area.left, area.right]);

  useEffect(
    () => () => {
      x.stop();
      y.stop();
    },
    [x, y],
  );

  const cycleCorner = () => {
    const currentIndex = corners.indexOf(corner);
    moveToCorner(corners[(currentIndex + 1) % corners.length]!);
  };
  const topLeft = getCornerPosition("top-left", area, viewer, viewportPadding);
  const bottomRight = getCornerPosition(
    "bottom-right",
    area,
    viewer,
    viewportPadding,
  );

  return (
    <motion.div
      aria-label={ariaLabel}
      data-slot="floating-viewer"
      className={cn(
        "group/viewer fixed left-0 top-0 isolate z-50 cursor-grab touch-none rounded-2xl pt-12 shadow-xl shadow-black/20 active:cursor-grabbing",
        className,
      )}
      drag
      dragConstraints={{
        left: topLeft.x,
        right: bottomRight.x,
        top: topLeft.y,
        bottom: bottomRight.y,
      }}
      dragElastic={0.08}
      dragMomentum={false}
      layout={!shouldReduceMotion}
      onDragStart={() => {
        x.stop();
        y.stop();
      }}
      onDragEnd={(_, info) => {
        const nextCorner: FloatingViewerCorner = `${
          info.point.y < (area.top + area.bottom) / 2 ? "top" : "bottom"
        }-${info.point.x < (area.left + area.right) / 2 ? "left" : "right"}`;
        moveToCorner(nextCorner);
      }}
      ref={surfaceRef}
      role="region"
      style={{
        width: Math.max(
          0,
          Math.min(floatingWidth, area.right - area.left - viewportPadding * 2),
        ),
        x,
        y,
      }}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
    >
      {children}
      <div
        role="toolbar"
        aria-label={`${ariaLabel} controls`}
        className="absolute inset-x-0 top-2 flex items-center justify-between gap-1 rounded-full bg-black/60 p-1 text-white backdrop-blur-md"
      >
        <FloatingViewerButton
          label={`Move viewer from ${corner}`}
          onClick={cycleCorner}
        >
          <path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5" />
        </FloatingViewerButton>
        {controls}
      </div>
    </motion.div>
  );
}

/**
 * Floating toolbar button; pointer presses do not begin a surface drag.
 * Children are SVG paths. Native button props carry disabled and pressed states.
 * @example <FloatingViewerButton label="Minimize" onClick={minimize}><path d="M5 12h14" /></FloatingViewerButton>
 */
export function FloatingViewerButton({
  children,
  label,
  ...props
}: {
  children: ReactNode;
  label: string;
} & Omit<
  ComponentProps<"button">,
  "children" | "className" | "onPointerDown"
>) {
  return (
    <button
      {...props}
      aria-label={label}
      className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:pointer-events-none disabled:opacity-30"
      onPointerDown={(event) => event.stopPropagation()}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="size-4"
        fill="none"
        viewBox="0 0 24 24"
      >
        <g
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        >
          {children}
        </g>
      </svg>
    </button>
  );
}
