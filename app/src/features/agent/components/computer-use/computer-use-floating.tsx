// Purpose: Compose screenshot controls with the shared floating surface.
import { useState, type ReactNode } from "react";
import {
  FloatingViewer,
  FloatingViewerButton,
  type FloatingViewerBounds,
} from "@openchart/app/components/ui/floating-viewer/floating-viewer";

/**
 * Owns only Computer Use minimization; the shared viewer owns all placement.
 * Hiding the screen keeps playback mounted, independent of Worked disclosure.
 * @example <ComputerUseFloating controls={navigation}>{screen}</ComputerUseFloating>
 */
export function ComputerUseFloating({
  children,
  controls,
  bounds,
}: {
  children: ReactNode;
  controls?: ReactNode;
  bounds?: FloatingViewerBounds;
}) {
  const [minimized, setMinimized] = useState(false);
  return (
    <div data-aui-quote-selectable="false">
      <FloatingViewer
        ariaLabel="Computer use preview"
        bounds={bounds}
        controls={
          <>
            {controls}
            <FloatingViewerButton
              label={
                minimized ? "Show computer screen" : "Minimize computer screen"
              }
              onClick={() => setMinimized(!minimized)}
            >
              {minimized ? (
                <path d="M3 4h18v13H3zM8 21h8m-4-4v4" />
              ) : (
                <path d="M5 12h14" />
              )}
            </FloatingViewerButton>
          </>
        }
      >
        <div hidden={minimized}>{children}</div>
      </FloatingViewer>
    </div>
  );
}
