// Purpose: Render standalone Markdown without a conversation runtime or executable HTML.
import "katex/dist/katex.min.css";
import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { resourceRemarkPlugins } from "@openchart/app/lib/resource/remark-resource-references";
import { cn } from "@openchart/app/utils/cn";

/** An inline `:resource[Label]{name=type/id}` reference parsed from the text. */
export type MarkdownResourceReference = {
  resource: string;
  id: string;
  label: string;
};

const remarkPlugins = [remarkGfm, ...resourceRemarkPlugins];
// Only `$$` display blocks are math, so a price such as $5 stays text.
const mathRemarkPlugins: NonNullable<Options["remarkPlugins"]> = [
  ...remarkPlugins,
  [remarkMath, { singleDollarTextMath: false }],
];
const mathRehypePlugins = [rehypeKatex];
// Media arrives through explicit attachment components; embedded players never render.
const disallowedElements = ["img", "video", "audio", "iframe"];

/**
 * Render inert Markdown: raw HTML stays text and unsafe link protocols are dropped.
 * Resource references render through the host's `renderReference`, or as their label.
 * With `math`, a `$$` block renders as a KaTeX formula; single `$` stays text.
 * @example <Markdown text="**Saved analysis**" />
 */
export function Markdown({
  text,
  className,
  renderReference,
  math = false,
}: {
  text: string;
  className?: string;
  renderReference?: (reference: MarkdownResourceReference) => ReactNode;
  math?: boolean;
}) {
  return (
    <div
      className={cn(
        // Inline code keeps its monospace style without Typography's literal backticks.
        "prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-a:text-primary prose-code:before:content-none prose-code:after:content-none prose-pre:overflow-x-auto [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={math ? mathRemarkPlugins : remarkPlugins}
        rehypePlugins={math ? mathRehypePlugins : undefined}
        disallowedElements={disallowedElements}
        unwrapDisallowed
        components={{
          // Without raw HTML, spans come from Resource directives and KaTeX,
          // whose class and style attributes lay out the formula.
          span: ({
            children,
            "data-resource-type": resource,
            "data-resource-id": id,
            "data-resource-label": label,
            ...props
          }: ComponentProps<"span"> & {
            node?: unknown;
            "data-resource-type"?: string;
            "data-resource-id"?: string;
            "data-resource-label"?: string;
          }) => {
            // The rest object is local; Markdown AST metadata is not a DOM attribute.
            delete props.node;
            return resource && id && label ? (
              (renderReference?.({ resource, id, label }) ?? label)
            ) : (
              <span {...props}>{children}</span>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
