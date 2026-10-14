// Purpose: Secret draft input with reveal and copy actions.
import { Copy, CopyCheck, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import {
  forwardRef,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
} from "react";

import { Input } from "@openchart/app/components/ui/input";
import { cn } from "@openchart/app/utils/cn";

type SecretInputProps = Omit<ComponentPropsWithoutRef<typeof Input>, "type">;

/** Edits only a caller-owned secret draft; nothing is fetched, stored, or logged. Clipboard failures use the shared toast without including the secret. @example <SecretInput id="api-key" value={draft} onChange={edit} disabled={saving} /> */
export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  ({ className, value, disabled, ...props }, ref) => {
    const [revealed, setRevealed] = useState(false);
    const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
    const stringValue = typeof value === "string" ? value : String(value ?? "");
    useEffect(() => {
      if (copyStatus === "idle") return;
      const timer = setTimeout(() => setCopyStatus("idle"), 2000);
      return () => clearTimeout(timer);
    }, [copyStatus]);
    const handleCopy = async () => {
      if (disabled || !stringValue) return;
      try {
        await navigator.clipboard.writeText(stringValue);
        setCopyStatus("copied");
      } catch {
        setCopyStatus("idle");
        toast.error("Couldn’t copy to clipboard", {
          description: "Select the text and copy it manually.",
        });
      }
    };
    return (
      <div className="relative w-full">
        <Input
          {...props}
          ref={ref}
          value={value}
          disabled={disabled}
          type={revealed ? "text" : "password"}
          className={cn("pr-16", className)}
        />
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <button
            type="button"
            aria-label={revealed ? "Hide" : "Reveal"}
            aria-pressed={revealed}
            disabled={disabled}
            className="rounded p-1 text-muted-foreground hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? (
              <EyeOff size={16} aria-hidden="true" />
            ) : (
              <Eye size={16} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            aria-label="Copy"
            disabled={disabled || !stringValue}
            className="rounded p-1 text-muted-foreground hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            onClick={() => {
              void handleCopy();
            }}
          >
            {copyStatus === "copied" ? (
              <CopyCheck
                size={16}
                className="text-primary"
                aria-hidden="true"
              />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        <span role="status" className="sr-only">
          {copyStatus === "copied" ? "Copied" : ""}
        </span>
      </div>
    );
  },
);
SecretInput.displayName = "SecretInput";
