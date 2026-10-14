// Purpose: Feed one work cycle's screenshots into the Computer Use view.
import { useMemo, useState } from "react";
import type { ComputerSequence } from "@openchart/app/features/agent/ag-ui/tool-media";
import {
  FloatingViewerButton,
  type FloatingViewerBounds,
} from "@openchart/app/components/ui/floating-viewer/floating-viewer";
import { ComputerUse, type ComputerStep } from "./computer-use";
import { ComputerUseFloating } from "./computer-use-floating";
import { Screenshot, ScreenshotPreview } from "./screenshot";

// Decorative positions, not recorded pointer input. Stable across updates/replay.
const cursorTrail = [
  { x: 36, y: 30 },
  { x: 58, y: 44 },
  { x: 44, y: 68 },
  { x: 65, y: 60 },
  { x: 38, y: 52 },
  { x: 60, y: 25 },
];

/**
 * Follows new captures by default. Browsing keeps the selected frame until the
 * user returns to latest or another user turn starts. Images remain transcript-owned.
 * @example <ComputerUsePlayback sequence={sequence} />
 */
export function ComputerUsePlayback({
  sequence,
  bounds,
}: {
  sequence: ComputerSequence;
  bounds?: FloatingViewerBounds;
}) {
  const [selection, setSelection] = useState<{
    turnId: string;
    frameId: string;
  }>();
  const selected =
    selection?.turnId === sequence.id
      ? sequence.frames.findIndex((frame) => frame.id === selection.frameId)
      : -1;
  const following = selected === -1;
  const activeIndex = following ? sequence.frames.length - 1 : selected;
  const frame = sequence.frames[activeIndex]!;
  const steps = useMemo<ComputerStep[]>(
    () =>
      sequence.frames.map((capture, index) => ({
        id: capture.id,
        ...cursorTrail[index % cursorTrail.length]!,
      })),
    [sequence.frames],
  );

  function select(index: number) {
    setSelection(
      index === sequence.frames.length - 1
        ? undefined
        : {
            turnId: sequence.id,
            frameId: sequence.frames[index]!.id,
          },
    );
  }

  return (
    <ComputerUseFloating
      bounds={bounds}
      controls={
        <>
          <FloatingViewerButton
            label="Previous screenshot"
            disabled={activeIndex === 0}
            onClick={() => select(activeIndex - 1)}
          >
            <path d="m15 18-6-6 6-6" />
          </FloatingViewerButton>
          <FloatingViewerButton
            label="Follow latest screenshot"
            aria-pressed={following}
            onClick={() => setSelection(undefined)}
          >
            <circle cx="12" cy="12" r="2" />
            <path d="M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
          </FloatingViewerButton>
          <FloatingViewerButton
            label="Next screenshot"
            disabled={activeIndex === sequence.frames.length - 1}
            onClick={() => select(activeIndex + 1)}
          >
            <path d="m9 18 6-6-6-6" />
          </FloatingViewerButton>
        </>
      }
    >
      <ComputerUse
        className="dark border-white/10 bg-black/60 backdrop-blur-md dark:bg-black/60"
        url={frame.title}
        steps={steps}
        activeIndex={activeIndex}
        title="Illustrative cursor movement"
      >
        <ScreenshotPreview src={frame.url}>
          <button
            type="button"
            aria-label="Enlarge computer screenshot"
            className="block aspect-[16/10] w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Screenshot src={frame.url} />
          </button>
        </ScreenshotPreview>
      </ComputerUse>
    </ComputerUseFloating>
  );
}
