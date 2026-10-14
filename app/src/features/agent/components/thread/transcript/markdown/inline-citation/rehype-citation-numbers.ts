// Purpose: Number web sources deterministically without changing Markdown text.
import type { Element, Root } from "hast";

/** Give each distinct web URL a number in this Markdown part's source order.
 * @example rehypePlugins={[rehypeCitationNumbers]}
 */
export function rehypeCitationNumbers() {
  return (tree: Root) => {
    const numbers = new Map<string, number>();
    function visit(parent: Root | Element) {
      for (const node of parent.children) {
        if (node.type !== "element") continue;
        const href = node.properties.href;
        if (node.tagName === "a" && typeof href === "string") {
          try {
            const url = new URL(href);
            if (["http:", "https:"].includes(url.protocol)) {
              const number = numbers.get(url.href) ?? numbers.size + 1;
              numbers.set(url.href, number);
              node.properties["data-citation-number"] = number;
            }
          } catch {
            // Relative links and fragments retain their original rendering.
          }
        }
        visit(node);
      }
    }
    visit(tree);
  };
}
