import { StrictMode } from "react";
import {
  renderWithToaster,
  findErrorToast,
} from "@openchart/app/testing/test-utils";
// Purpose: Live/polled failures announce transitions and retain current retry actions.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { toast, type ToastT } from "sonner";
import { useErrorToast } from "@openchart/app/hooks/use-error-toast";

afterEach(() => {
  toast.getToasts().forEach(({ id }) => toast.dismiss(id));
});

test("polling an unchanged failed job does not recreate a dismissed notification", async () => {
  const { rerender, unmount } = renderHook(
    ({ error }: { error?: string }) =>
      useErrorToast(error, {
        id: "index:run-1",
        title: "Couldn’t index Binance",
      }),
    { initialProps: { error: "Network unavailable" as string | undefined } },
  );
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(1);
  act(() => {
    toast.getToasts().forEach(({ id }) => toast.dismiss(id));
  });
  rerender({ error: "Network unavailable" });
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(0);
  rerender({ error: undefined });
  rerender({ error: "Network unavailable" });
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(1);
  unmount();
  await waitFor(() => expect(toast.getToasts()).toHaveLength(0));
});

test("retry uses the latest callback and recovery dismisses the failure", () => {
  const first = vi.fn(),
    second = vi.fn();
  const { rerender } = renderHook(
    ({ error, retry }: { error?: string; retry: () => void }) =>
      useErrorToast(error, {
        id: "chart:test",
        title: "Couldn’t update chart",
        retry,
      }),
    { initialProps: { error: "Offline" as string | undefined, retry: first } },
  );
  rerender({ error: "Offline", retry: second });
  const action = toast
    .getToasts()
    .filter((item): item is ToastT => "title" in item)[0]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action))
    throw new Error("Missing retry action");
  act(() => action.onClick({} as React.MouseEvent<HTMLButtonElement>));
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  rerender({ error: undefined, retry: second });
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(0);
});

test("StrictMode replay leaves one visible error notification", async () => {
  function Failure() {
    useErrorToast("Network unavailable", {
      id: "strict-mode-failure",
      title: "Couldn’t index Binance",
    });
    return null;
  }
  renderWithToaster(
    <StrictMode>
      <Failure />
    </StrictMode>,
  );
  await findErrorToast("Network unavailable");
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
  expect(await findErrorToast("Network unavailable")).toBeInTheDocument();
  expect(toast.getToasts()).toHaveLength(1);
});
