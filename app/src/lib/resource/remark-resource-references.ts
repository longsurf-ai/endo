// Purpose: Interpret one inline Resource directive through the standard Markdown parser.
import type { Root, RootContent } from "mdast";
import remarkDirective from "remark-directive";
import { toString } from "mdast-util-to-string";
import { visitParents, SKIP } from "unist-util-visit-parents";
import { z } from "zod";

const referenceAttributes = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\/.+$/)
      .transform((name) => {
        const separator = name.indexOf("/");
        return {
          resource: name.slice(0, separator),
          id: name.slice(separator + 1),
        };
      }),
  })
  .strict();

function remarkResourceReferences() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    visitParents(tree, (node, ancestors) => {
      if (
        node.type !== "textDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "containerDirective"
      )
        return;
      const attributes = referenceAttributes.safeParse(node.attributes);
      const label = toString(node);
      const raw = source.slice(
        node.position?.start.offset,
        node.position?.end.offset,
      );
      if (
        node.type === "textDirective" &&
        node.name === "resource" &&
        attributes.success &&
        label.trim() &&
        raw.endsWith("}") &&
        !ancestors.some(
          (ancestor) =>
            ancestor.type === "link" || ancestor.type === "linkReference",
        )
      ) {
        node.data = {
          hName: "span",
          hProperties: {
            "data-resource-type": attributes.data.name.resource,
            "data-resource-id": attributes.data.name.id,
            "data-resource-label": label,
            "data-dig-in-excluded": true,
          },
        };
        node.children = [{ type: "text", value: label }];
      } else {
        // Unknown, malformed and partially streamed directives remain literal.
        const parent = ancestors.at(-1);
        if (parent) {
          const children: RootContent[] = parent.children;
          children.splice(children.indexOf(node), 1, {
            type: "text",
            value: raw,
          });
        }
      }
      return SKIP;
    });
  };
}

/** Parse :resource[Label]{name=alert_rule/alr_1} without interpreting code or escaped syntax.
 * Invalid/unsupported directives remain readable source; only validated identity reaches React.
 * @example <MarkdownTextPrimitive remarkPlugins={resourceRemarkPlugins} />
 */
export const resourceRemarkPlugins = [
  remarkDirective,
  remarkResourceReferences,
];
