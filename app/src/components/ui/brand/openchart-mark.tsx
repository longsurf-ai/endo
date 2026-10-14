// Purpose: Render the OpenChart brand glyph in the surrounding text color.
import type { ComponentProps } from "react";

/**
 * Render the brand mark; the containing link or adjacent text supplies its label.
 * @example
 * <OpenChartMark className="size-5" />
 */
export function OpenChartMark(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="48 47 308 308"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M 307 96 C 280 73 250 60 217 60 C 139 60 74 122 74 200 C 74 251 99 295 142 320 C 161 313 169 289 164 263 C 161 246 152 230 148 213 C 142 188 154 163 173 147 C 191 132 211 130 232 136 C 251 142 269 144 283 136 C 297 128 304 112 307 96 Z" />
      <path d="M 203 341 C 198 327 199 313 205 301 C 219 270 247 258 278 256.5 C 301 255 316 266 329 281 C 300 319 253 344 203 341 Z" />
    </svg>
  );
}
