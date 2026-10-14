// Purpose: Merge Tailwind classes while recognizing V2 semantic icon dimensions.
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: { spacing: [{ icon: ["xs", "sm", "md", "lg", "xl"] }] },
  },
});

/**
 * Combine conditional classes and let later utilities override earlier defaults.
 * @example
 * cn('size-icon-md', 'size-icon-lg'); // 'size-icon-lg'
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
