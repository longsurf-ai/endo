// Purpose: Share the Sidebar mobile breakpoint and media-query listener.
import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Track the 768px mobile breakpoint and remove its listener on unmount.
 * @example
 * const isMobile = useIsMobile();
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
