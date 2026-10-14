// Purpose: Keep floating content inside the conversation and above its footer.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { AgentLayout } from "@openchart/app/features/agent/components/thread/agent-layout/agent-layout";

const thread = vi.hoisted(() => ({ firstMessageID: "latest" }));
vi.mock("@assistant-ui/react", async () => {
  const { forwardRef } = await import("react");
  return {
    useAuiState: () => thread.firstMessageID,
    ThreadPrimitive: {
      Viewport: forwardRef<HTMLDivElement, ComponentProps<"div">>(
        (props, ref) => <div {...props} ref={ref} data-testid="viewport" />,
      ),
      ViewportFooter: forwardRef<HTMLDivElement, ComponentProps<"div">>(
        (props, ref) => <div {...props} ref={ref} data-testid="footer" />,
      ),
      ScrollToBottom: ({ children }: { children: ReactNode }) => children,
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("loads near the top, anchors prepends independently of tail growth, and exposes retries", () => {
  const onLoadMore = vi.fn();
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    vi.fn((callback: IntersectionObserverCallback) => {
      intersect = callback;
      return { observe: vi.fn(), disconnect };
    }),
  );
  let messageTop = 60;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.transcriptMessage
        ? new DOMRect(0, messageTop, 200, 100)
        : new DOMRect(0, 0, 200, 400);
    },
  );
  const view = (loading: boolean, error: boolean, hasMore = true) => (
    <AgentLayout
      empty={false}
      transcript={<div data-transcript-message="latest">Latest answer</div>}
      composer={null}
      history={{
        hasMore,
        loading,
        error,
        onLoadMore,
        label: "Load earlier messages",
      }}
    />
  );
  const { rerender } = render(view(false, false));
  const viewport = screen.getByTestId("viewport");
  viewport.scrollTop = 120;
  act(() =>
    intersect(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(onLoadMore).toHaveBeenCalledOnce();
  rerender(view(true, false));
  expect(
    screen.getByRole("button", { name: "Load earlier messages" }),
  ).toBeDisabled();
  // A new page moves the visible message by 180px; unrelated tail growth is irrelevant.
  messageTop += 180;
  Object.defineProperty(viewport, "scrollHeight", { value: 2000 });
  thread.firstMessageID = "older";
  rerender(view(false, false));
  expect(viewport.scrollTop).toBe(300);
  rerender(view(false, true));
  expect(
    screen.getByRole("button", { name: "Load earlier messages" }),
  ).toHaveTextContent("Try again");
  fireEvent.click(
    screen.getByRole("button", { name: "Load earlier messages" }),
  );
  expect(onLoadMore).toHaveBeenCalledTimes(2);
  rerender(view(false, false, false));
  expect(
    screen.queryByRole("button", { name: "Load earlier messages" }),
  ).not.toBeInTheDocument();
  expect(disconnect).toHaveBeenCalled();
});

test("remeasures after sidebar resizing and composer growth and releases observers", () => {
  let left = 240;
  let footerTop = 650;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "viewport"
        ? new DOMRect(left, 60, 1280 - left, 740)
        : new DOMRect(left, footerTop, 1280 - left, 800 - footerTop);
    },
  );
  const { unmount } = render(
    <AgentLayout
      empty={false}
      transcript={<p>History</p>}
      composer={<input aria-label="Draft" />}
      floating={(bounds) => <output>{JSON.stringify(bounds)}</output>}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    JSON.stringify({ left: 240, top: 60, right: 1280, bottom: 650 }),
  );
  const observer = vi.mocked(ResizeObserver).mock.results[0]!.value;
  const onResize = vi.mocked(ResizeObserver).mock.calls[0]![0];
  expect(observer.observe).toHaveBeenCalledWith(screen.getByTestId("viewport"));
  expect(observer.observe).toHaveBeenCalledWith(screen.getByTestId("footer"));
  left = 0;
  footerTop = 540;
  act(() => onResize([], observer));
  expect(screen.getByRole("status")).toHaveTextContent(
    JSON.stringify({ left: 0, top: 60, right: 1280, bottom: 540 }),
  );
  unmount();
  expect(observer.disconnect).toHaveBeenCalledOnce();
});
