// Purpose: Render assistant Markdown with code, math and Mermaid blocks.
"use client";

import "@assistant-ui/react-markdown/styles/dot.css";
import "katex/dist/katex.min.css";

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  type ComponentProps,
  lazy,
  memo,
  Suspense,
  useRef,
  useMemo,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import {
  rehypeDigInAnchors,
  type AnchorRange,
} from "@openchart/app/features/agent/components/dig-in/rehype-dig-in-anchors";

import {
  type HighlighterProps,
  SyntaxHighlighter as ShikiSyntaxHighlighter,
} from "@openchart/app/features/agent/components/thread/transcript/markdown/shiki-highlighter/shiki-highlighter.aui";
import { CheckIcon, CopyIcon } from "lucide-react";
import { CodeBlock } from "@openchart/app/components/ui/code-block/code-block";
import { useCopyToClipboard } from "@openchart/app/features/agent/components/thread/transcript/markdown/use-copy-to-clipboard";
import { preprocessMath } from "@openchart/app/features/agent/components/thread/transcript/markdown/markdown-math";
import { cn } from "@openchart/app/utils/cn";
import { MarkdownLink } from "./inline-citation/inline-citation.aui";
import { rehypeCitationNumbers } from "./inline-citation/rehype-citation-numbers";
import { workspaceFileUrlTransform } from "./workspace-file-link";
import { resourceRemarkPlugins } from "@openchart/app/lib/resource/remark-resource-references";
import { ResourceReferenceSpan } from "./resource-reference";

// The diagram engine only loads once a mermaid fence arrives, so every other
// route that renders markdown keeps it out of its initial chunk.
const DeferredMermaidDiagram = lazy(() =>
  import("@openchart/app/features/agent/components/thread/transcript/markdown/mermaid-diagram/mermaid-diagram.aui").then(
    (mod) => ({ default: mod.MermaidDiagram }),
  ),
);

function LazyMermaidDiagram(
  props: ComponentProps<typeof DeferredMermaidDiagram>,
) {
  return (
    <Suspense
      fallback={
        <div aria-hidden className="h-32 animate-pulse rounded-b-md bg-muted" />
      }
    >
      <DeferredMermaidDiagram {...props} />
    </Suspense>
  );
}

// A table is printed matter like a code sheet, so it gets the same figure: a
// hairline sheet that scrolls on its own rather than pushing the column wide,
// and one action that takes the table with you. Copy reads the rendered rows,
// which is the only place the cell text exists: the memoized markdown
// components are handed rendered children with the hast node stripped, so
// there is no stable per-row key to sort on either.
function MarkdownTable({
  className,
  children,
  ...props
}: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const copy = () => {
    const table = ref.current;
    if (!table) return;

    const rows = [...table.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) =>
        (cell.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          // The backslash goes first: escaping the pipe alone would turn a cell's
          // own backslash into the escape for it.
          .replace(/[\\|]/g, "\\$&"),
      ),
    );
    if (rows.length === 0) return;

    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    const [header, ...body] = rows;
    copyToClipboard(
      [
        pad(header!),
        `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
        ...body.map(pad),
      ].join("\n"),
    );
  };

  return (
    <figure className="my-3 rounded-md border border-foreground/10">
      <div
        data-dig-in-excluded
        className="flex h-9 items-center justify-between rounded-t-md border-b border-foreground/10 bg-foreground/[0.025] px-3 dark:bg-foreground/[0.04]"
      >
        <span className="font-mono text-[11px] text-muted-foreground [font-variant-ligatures:none]">
          table
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy table as markdown"
          className="grid size-6 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {isCopied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table
          ref={ref}
          className={cn(
            "w-full border-separate border-spacing-0 text-[13px]",
            className,
          )}
          {...props}
        >
          {children}
        </table>
      </div>
    </figure>
  );
}

// Fenced code and mermaid fences render inside the site's CodeBlock, the same
// code sheet the docs pages use, so the kit highlighter only supplies tokens
// and its own chrome is reset.
const codeSheetReset =
  "[&_pre]:rounded-none [&_pre]:border-0 [&_pre]:!bg-transparent [&_pre]:px-3.5 [&_pre]:py-0 [&_pre]:text-[12.5px] [&_pre]:overflow-visible";

const SyntaxHighlighter = (props: HighlighterProps) => (
  <CodeBlock
    title={props.language || undefined}
    copyText={props.code}
    className="my-3"
  >
    <ShikiSyntaxHighlighter {...props} className={codeSheetReset} />
  </CodeBlock>
);

const MermaidDiagram = (props: ComponentProps<typeof LazyMermaidDiagram>) => (
  <CodeBlock title="mermaid" copyText={props.code} className="my-3">
    <LazyMermaidDiagram
      {...props}
      className="-my-1.5 rounded-none bg-transparent"
    />
  </CodeBlock>
);

const NoCodeHeader = () => null;

const remarkPlugins = [remarkGfm, remarkMath, ...resourceRemarkPlugins];
const componentsByLanguage = {
  mermaid: { SyntaxHighlighter: MermaidDiagram },
};

const MarkdownTextImpl = () => {
  const digIn = useAgentView();
  const partID = useAuiState((s) => s.message.id);
  const sourceMessageID = useAuiState(
    (s) => s.message.metadata.custom.sourceMessageId,
  );
  const settled = useAuiState(
    (s) => s.message.metadata.custom.showActions === true,
  );
  const anchors = digIn?.session?.anchors;
  const pending = digIn?.pending;
  const rehypePlugins = useMemo(() => {
    const ranges: AnchorRange[] = (anchors ?? []).filter(
      (anchor) => anchor.partId === partID,
    );
    if (
      pending?.input.selection.partId === partID &&
      !ranges.some(
        (anchor) =>
          anchor.startOffset === pending.input.selection.startOffset &&
          anchor.endOffset === pending.input.selection.endOffset,
      )
    ) {
      ranges.push({
        startOffset: pending.input.selection.startOffset,
        endOffset: pending.input.selection.endOffset,
      });
    }
    return [
      rehypeKatex,
      rehypeCitationNumbers,
      [rehypeDigInAnchors, ranges] as [
        typeof rehypeDigInAnchors,
        typeof ranges,
      ],
    ];
  }, [anchors, pending, partID]);
  return (
    <MarkdownTextPrimitive
      containerProps={{
        className: "min-w-0",
        ...{
          "data-dig-in-part": partID,
          "data-dig-in-message":
            typeof sourceMessageID === "string" ? sourceMessageID : undefined,
          "data-dig-in-eligible": settled,
        },
      }}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={workspaceFileUrlTransform}
      componentsByLanguage={componentsByLanguage}
      preprocess={preprocessMath}
      // eslint-disable-next-line tailwindcss/no-custom-classname -- aui-md is required by the imported assistant-ui dot.css.
      className="aui-md [overflow-wrap:anywhere] [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1"
      components={defaultComponents}
      // Reveal the provider's stream directly. A second typewriter queue can
      // lag behind it and jump to the remaining text when the reply completes.
      smooth={false}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents({
  span: ResourceReferenceSpan,
  SyntaxHighlighter,
  CodeHeader: NoCodeHeader,
  h1: ({ className, children, ...props }) => (
    <h1
      className={cn(
        "mb-2 mt-5 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ className, children, ...props }) => (
    <h2
      className={cn(
        "mb-2 mt-5 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ className, children, ...props }) => (
    <h3
      className={cn(
        "mb-1.5 mt-4 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ className, children, ...props }) => (
    <h4
      className={cn(
        "mb-1 mt-3.5 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h4>
  ),
  h5: ({ className, children, ...props }) => (
    <h5
      className={cn(
        "mb-1 mt-3 text-sm font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h5>
  ),
  h6: ({ className, children, ...props }) => (
    <h6
      className={cn(
        "mb-1 mt-3 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h6>
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn("my-3 leading-relaxed first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  a: MarkdownLink,
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "my-3 border-s-2 border-muted-foreground/30 ps-4 text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "my-3 ms-5 list-disc marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "my-3 ms-5 list-decimal marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("my-3 border-muted-foreground/20", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <MarkdownTable className={className} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "[[align=center]]:text-center [[align=right]]:text-right min-w-40 border-b border-foreground/10 px-3 py-1.5 text-start font-medium",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "[[align=center]]:text-center [[align=right]]:text-right min-w-40 border-b border-foreground/10 px-3 py-1.5 text-start",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr className={cn("m-0 p-0", className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn("font-semibold", className)} {...props} />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("[&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "overflow-x-auto rounded-b-xl rounded-t-none border border-t-0 border-border/50 bg-muted/30 p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
});
