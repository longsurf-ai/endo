// Purpose: Mount the shared Sonner presentation using the app's existing theme.
import { createPortal } from "react-dom";
import { useDarkTheme } from "@openchart/app/lib/theme/theme";
import { Toaster as Sonner } from "sonner";

/**
 * One app-wide toaster; follows ThemeProvider without owning theme state. It
 * mounts in a body portal, as dialogs do: the app root is isolated (see
 * DESIGN.md), so inside it every toast would sit under an open dialog.
 * @example <Toaster />
 */
export function Toaster() {
  const dark = useDarkTheme();
  return createPortal(
    <Sonner
      theme={dark ? "dark" : "light"}
      className="toaster group"
      richColors
      position="top-right"
      // 8px margin below our 60px page and agent panel headers.
      offset={{ top: 68, right: 8 }}
      visibleToasts={5}
      toastOptions={{
        style: {
          padding: "1rem 0.8rem",
          alignItems: "start",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
        },
        classNames: {
          toast: "toast",
          title: "!text-foreground",
          description: "!text-muted-foreground",
        },
      }}
    />,
    document.body,
  );
}
