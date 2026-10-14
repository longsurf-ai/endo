"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@openchart/app/utils/cn";

const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

const labelSwapIn = "opacity-100 blur-none";

const labelSwapOut = "pointer-events-none select-none opacity-0 blur-[2px]";

/** Swap the two labels while animating to the active label's measured width. @example <SwapLabel active={0}>{["Running", "Done"]}</SwapLabel> */
export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const first = useRef<HTMLSpanElement>(null);
  const second = useRef<HTMLSpanElement>(null);
  const activeLayer = active === 0 ? first : second;
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = activeLayer.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [activeLayer]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid max-w-full overflow-x-clip transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={index === 0 ? first : second}
          aria-hidden={active !== index}
          className={cn(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
