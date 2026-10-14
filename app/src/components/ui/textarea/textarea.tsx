// Purpose: Plain multiline input with React 18 ref forwarding.
import * as React from "react";

import { cn } from "@openchart/app/utils/cn";

/** Plain textarea; labels, drafts and persistence belong to the form. @example <Textarea id="model-ids" rows={3} value={draft} onChange={edit} /> */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    data-slot="textarea"
    ref={ref}
    className={cn(
      "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] [field-sizing:content] [overflow-wrap:anywhere] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 md:text-sm",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
