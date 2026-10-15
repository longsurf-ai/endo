// Purpose: Display the supplied Endo artwork consistently across app surfaces.
import type { ComponentProps } from "react";
import artwork from "./endo.png";

/**
 * Renders Endo's bundled artwork without recoloring it. Decorative by default;
 * pass alt text when there is no adjacent label. Consumers own size and layout.
 * Holds no state or resources; the bundled image requires no network service.
 * @example <EndoMark className="size-8 rounded-md" alt="Endo" />
 */
export function EndoMark({
  alt = "",
  ...props
}: Omit<ComponentProps<"img">, "src">) {
  return <img src={artwork} alt={alt} {...props} />;
}
