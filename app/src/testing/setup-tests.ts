import { toast } from "sonner";
// Purpose: Supply browser APIs for app tests.
import "@testing-library/jest-dom/vitest";

vi.mock("zustand");

// jsdom has no beforeinput target ranges. Expose the selection so rich-text
// editors can handle user-event's beforeinput just as they do in a browser.
InputEvent.prototype.getTargetRanges = function () {
  const selection = document.getSelection();
  return selection?.rangeCount ? [selection.getRangeAt(0)] : [];
};
// jsdom has no layout; Lexical measures the caret when scrolling into view.
Range.prototype.getBoundingClientRect = () => new DOMRect();
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

// Chromium focuses the editing host when code moves the selection into it.
// jsdom updates the range only, which otherwise leaves Lexical autofocus inert.
const setBaseAndExtent = Selection.prototype.setBaseAndExtent;
Selection.prototype.setBaseAndExtent = function (anchor, ...rest) {
  setBaseAndExtent.call(this, anchor, ...rest);
  const element = anchor instanceof Element ? anchor : anchor.parentElement;
  element?.closest<HTMLElement>('[contenteditable="true"]')?.focus();
};

// jsdom does not implement pointer capture used by Sonner's swipe gestures.
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;

beforeEach(() => {
  toast.getToasts().forEach(({ id }) => toast.dismiss(id));
  const ResizeObserverMock = vi.fn(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  // Embla, behind the shared Carousel, watches slide visibility.
  vi.stubGlobal("IntersectionObserver", ResizeObserverMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      media: query,
      matches: false,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});
