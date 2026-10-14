// Purpose: Own app keyboard shortcut registration and cleanup.
import { useEffect } from "react";

/** An action bound to a Cmd/Ctrl key combination and its held-key behavior. */
type Shortcut = {
  /**
   * Runs when the shortcut matches. Must handle its own failures; the hook
   * neither awaits returned promises nor catches errors.
   */
  action: () => void | Promise<void>;
  /**
   * Whether holding the key may trigger the action repeatedly. When false,
   * repeated keydown events still prevent the browser's default behavior.
   */
  allowRepeat: boolean;
  /** Keep native selection/editing and modal controls available, e.g. Cmd+A. */
  allowInEditable?: boolean;
};

/**
 * Bind Cmd/Ctrl shortcuts by lowercase key, with an explicit key-repeat policy.
 * Mount once in the app layout; disabled shortcuts leave key events untouched.
 * Matched keys prevent browser defaults even when repeat execution is disabled.
 * Removes the listener on cleanup. Supplied actions own failure handling.
 * @example useKeyboardShortcut({ disabled: false, bindings: { n: { action: newChat, allowRepeat: true } } });
 */
export function useKeyboardShortcut({
  disabled,
  bindings,
}: {
  disabled: boolean;
  bindings: Readonly<Record<string, Shortcut>>;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return;
      const shortcut = bindings[event.key.toLowerCase()];
      if (!shortcut) return;
      if (
        shortcut.allowInEditable === false &&
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="dialog"], .monaco-editor',
        )
      )
        return;
      event.preventDefault();
      if (!event.repeat || shortcut.allowRepeat) void shortcut.action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, bindings]);
}
