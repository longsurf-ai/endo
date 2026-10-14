// Purpose: Decorate rendered Markdown text ranges while preserving its element tree.
import type { Element, Root, RootContent } from "hast";

export type AnchorRange = {
  startOffset: number;
  endOffset: number;
  childSessionId?: string;
};

/** Rehype plugin for stable rendered-text offsets and anchor fragments. @example rehypePlugins={[[rehypeDigInAnchors, anchors]]} */
export function rehypeDigInAnchors(anchors: readonly AnchorRange[] = []) {
  return (tree: Root) => {
    let offset = 0;
    function visit(parent: Root | Element) {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === "element") {
          const classes = node.properties.className;
          if (
            ["pre", "code", "math", "svg"].includes(node.tagName) ||
            (Array.isArray(classes) &&
              classes.some((name) => String(name).startsWith("katex")))
          ) {
            node.properties["data-dig-in-excluded"] = true;
          } else visit(node);
          return [node];
        }
        if (node.type !== "text") return [node];
        const start = offset;
        const end = (offset += node.value.length);
        // Keep structural whitespace as text: spans cannot be children of a
        // table/row/list, and adding them would change the browser's DOM tree.
        if (
          !node.value.trim() &&
          (parent.type === "root" ||
            ["table", "thead", "tbody", "tfoot", "tr", "ul", "ol"].includes(
              parent.tagName,
            ))
        )
          return [node];
        const relevant = anchors.filter(
          (anchor) => anchor.startOffset < end && anchor.endOffset > start,
        );
        const boundaries = [
          ...new Set([
            start,
            end,
            ...relevant.flatMap((anchor) => [
              Math.max(start, anchor.startOffset),
              Math.min(end, anchor.endOffset),
            ]),
          ]),
        ].sort((a, b) => a - b);
        const children: RootContent[] = [];
        for (let i = 0; i < boundaries.length - 1; i++) {
          const from = boundaries[i]!;
          const to = boundaries[i + 1]!;
          // The latest anchor owns overlapping text; never nest interactive markers.
          const anchor = [...relevant]
            .reverse()
            .find((item) => item.startOffset <= from && item.endOffset >= to);
          const text = {
            type: "text" as const,
            value: node.value.slice(from - start, to - start),
          };
          children.push(
            anchor
              ? {
                  type: "element",
                  tagName: "span",
                  properties: {
                    "data-dig-in-child": anchor.childSessionId ?? "",
                  },
                  children: [text],
                }
              : text,
          );
        }
        return [
          {
            type: "element",
            tagName: "span",
            properties: { "data-dig-in-start": start },
            children: children as Element["children"],
          },
        ];
      }) as Element["children"];
    }
    visit(tree);
  };
}
