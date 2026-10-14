// Purpose: Request another page with the shared button, loading state and retry feedback.
import { Button } from "@openchart/app/components/ui/button";

/** Query owns page data and request state; this control only requests more. */
export type LoadMoreProps = {
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  onLoadMore: () => void;
  /** Accessible name identifying the list controlled by this button. */
  label: string;
};

/** Keep pagination explicit when multiple lists share a scroll container. @example <LoadMore hasMore={query.hasNextPage} loading={query.isFetching} error={query.isFetchNextPageError} onLoadMore={loadMore} label="Show more" /> */
export function LoadMore({
  hasMore,
  loading,
  error,
  onLoadMore,
  label,
}: LoadMoreProps) {
  if (!hasMore) return null;
  return (
    <div className="px-2 py-1">
      <Button
        variant="link"
        size="sm"
        className="w-full justify-start rounded-md px-0 font-normal text-muted-foreground hover:text-foreground hover:no-underline"
        aria-label={label}
        disabled={loading}
        isLoading={loading}
        onClick={onLoadMore}
      >
        {error ? "Try again" : "Show more"}
      </Button>
    </div>
  );
}
