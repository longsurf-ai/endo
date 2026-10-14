// Purpose: Announce failures from non-Query state once until recovery, without a second error store.
import { useEffect, useRef } from "react";
import { toast } from "sonner";

/** Report an observed failure; polling/rerenders do not repeat it. Recovery and unmount dismiss it; retry uses the current callback. Query errors are reported by the QueryClient instead. @example useErrorToast(error, { id: sourceId, title: "Couldn’t update chart", retry }); */
export function useErrorToast(
  error: Error | string | null | undefined,
  { id, title, retry }: { id: string; title: string; retry?: () => void },
) {
  const message = typeof error === "string" ? error : error?.message;
  const retryRef = useRef(retry);
  const mountedId = useRef<string>();
  const shown = useRef<{ source: string; toastId: string | number }>();
  retryRef.current = retry;
  useEffect(() => {
    if (
      shown.current &&
      (shown.current.source !== id || message === undefined)
    ) {
      toast.dismiss(shown.current.toastId);
      shown.current = undefined;
    }
    if (message === undefined) return;
    const toastId = toast.error(title, {
      id: shown.current?.toastId,
      description: message,
      action: retryRef.current
        ? { label: "Retry", onClick: () => retryRef.current?.() }
        : undefined,
    });
    shown.current = { source: id, toastId };
  }, [id, title, message]);
  useEffect(() => {
    mountedId.current = id;
    return () => {
      mountedId.current = undefined;
      // StrictMode immediately reattaches the same observer. Only a real
      // unmount or identity change should dismiss its still-current failure.
      queueMicrotask(() => {
        if (mountedId.current !== id && shown.current?.source === id) {
          toast.dismiss(shown.current.toastId);
          shown.current = undefined;
        }
      });
    };
  }, [id]);
}
