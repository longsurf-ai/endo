// Uses local CSS for the active-label shimmer.
"use client";

import type { ComponentProps } from "react";

import "./shimmer-label.css";

/** Apply the active-label shimmer. @example <ShimmerLabel active>Searching</ShimmerLabel> */
export function ShimmerLabel({
  active = true,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      data-slot="shimmer-label"
      data-active={active || undefined}
      {...props}
    />
  );
}
