// Purpose: Connect Markdown links to the official citation view on hover only.
import {
  Children,
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { cn } from "@openchart/app/utils/cn";
import { CitationSource, InlineCitation } from "./inline-citation";
import { WorkspaceFileLink } from "@openchart/app/features/agent/components/thread/transcript/markdown/workspace-file-link";

function linkText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child): string => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? linkText(child.props.children)
        : "";
    })
    .join("");
}

function LinkPreview({ url, children }: { url: URL; children: ReactNode }) {
  const view = useAgentView();
  const { data } = useQuery({
    queryKey: ["linkPreview", url.href],
    queryFn: ({ signal }) =>
      view
        ? view.transport.rpc.agent.linkPreview.get
            .query({ url: url.href }, { signal })
            .catch(() => null)
        : Promise.resolve(null),
    enabled: !!view,
    gcTime: 30 * 60_000,
    staleTime: (query) => (query.state.data ? 5 * 60_000 : 0),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: icon } = useQuery({
    // Share the existing favicon cache with chart source badges.
    queryKey: ["favicon", url.hostname],
    queryFn: ({ signal }) =>
      view
        ? view.transport.rpc.favicon.get
            .query({ hostname: url.hostname }, { signal })
            .catch(() => null)
        : Promise.resolve(null),
    enabled: !!view,
    gcTime: 30 * 60_000,
    staleTime: (query) => (query.state.data ? Infinity : 0),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <CitationSource
      domain={url.hostname}
      icon={icon ?? null}
      title={data?.title ?? (linkText(children).trim() || url.hostname)}
      snippet={data?.description ?? null}
    />
  );
}

/**
 * Render external web links with assistant-ui citations. Query is mounted inside
 * the closed-by-default portal, so parsing/streaming Markdown never starts a
 * request. Query retains optional results in memory and cancels pending reads
 * on close. Cache misses take the same fetch path; failures retry next hover.
 * Local paths go through the reply's Workspace; web/mail links and fragments keep anchors.
 * @example components={{ a: MarkdownLink }}
 */
export function MarkdownLink({
  href,
  children,
  className,
  "data-citation-number": number,
  ...props
}: ComponentPropsWithoutRef<"a"> & { "data-citation-number"?: number }) {
  if (!href) return <>{children}</>;
  if (!/^(https?:|mailto:|tel:|#)/i.test(href)) {
    return <WorkspaceFileLink href={href}>{children}</WorkspaceFileLink>;
  }
  let url: URL | undefined;
  try {
    if (href) url = new URL(href);
  } catch {
    // Relative links and anchors have no external page metadata.
  }
  if (!url || !["http:", "https:"].includes(url.protocol) || !number) {
    return (
      <a
        href={href}
        className={cn(
          "text-primary underline underline-offset-2 hover:text-primary/80",
          className,
        )}
        {...props}
      >
        {children}
      </a>
    );
  }
  return (
    <>
      {children}
      <InlineCitation
        {...props}
        href={href}
        className={className}
        aria-label={`Source ${number}: ${linkText(children).trim() || url.hostname}`}
        data-dig-in-excluded
        preview={<LinkPreview url={url}>{children}</LinkPreview>}
      >
        {number}
      </InlineCitation>
    </>
  );
}
