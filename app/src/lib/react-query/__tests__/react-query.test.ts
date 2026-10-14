import { InfiniteQueryObserver } from "@tanstack/react-query";
// Purpose: Request failures are visible once, recoverable, and never silently replay writes.
import { afterEach, expect, test, vi } from "vitest";
import { toast, type ToastT } from "sonner";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";

afterEach(() => {
  toast.getToasts().forEach(({ id }) => toast.dismiss(id));
});

test("polling one failing query reports once until recovery", async () => {
  const client = createQueryClient();
  const request = vi.fn(async () => {
    throw new Error("Source unavailable");
  });
  const options = { queryKey: ["provider"], queryFn: request };
  await expect(client.fetchQuery(options)).rejects.toThrow(
    "Source unavailable",
  );
  await expect(client.fetchQuery(options)).rejects.toThrow(
    "Source unavailable",
  );
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(1);
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item)[0],
  ).toMatchObject({
    description: "Source unavailable",
    action: { label: "Retry" },
  });
  await client.fetchQuery({ ...options, queryFn: async () => 1 });
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(0);
  client.clear();
});

test("a failure that cannot succeed on retry offers no Retry", async () => {
  const client = createQueryClient();
  const failure = Object.assign(new Error("Not found"), {
    isRetryable: false,
  });
  await expect(
    client.fetchQuery({
      queryKey: ["missing"],
      queryFn: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  const [shown] = toast
    .getToasts()
    .filter((item): item is ToastT => "title" in item);
  expect(shown).toMatchObject({ description: failure.message });
  expect(shown?.action).toBeUndefined();
  client.clear();
});

test("a silent query leaves its failure to its consumer", async () => {
  const client = createQueryClient();
  await expect(
    client.fetchQuery({
      queryKey: ["silent"],
      meta: { silent: true },
      queryFn: async () => {
        throw new Error("expected expression");
      },
    }),
  ).rejects.toThrow("expected expression");
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(0);
  client.clear();
});

test("two observers of the same request share one failure notification", async () => {
  const client = createQueryClient();
  const options = {
    queryKey: ["shared"],
    queryFn: async () => {
      throw new Error("Offline");
    },
  };
  await Promise.allSettled([
    client.fetchQuery(options),
    client.fetchQuery(options),
  ]);
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(1);
  client.clear();
});

test("a nested mutation reports the same exception once and never retries writes", async () => {
  const client = createQueryClient();
  const write = vi.fn(async () => {
    throw new Error("Save failed");
  });
  const inner = client.getMutationCache().build(client, { mutationFn: write });
  const outer = client
    .getMutationCache()
    .build(client, { mutationFn: () => inner.execute(undefined) });
  await expect(outer.execute(undefined)).rejects.toThrow("Save failed");
  expect(write).toHaveBeenCalledTimes(1);
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(1);
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item)[0]
      ?.action,
  ).toBeUndefined();
  client.clear();
});

test("cancelling a query produces no error toast", async () => {
  const client = createQueryClient();
  const pending = client.fetchQuery({
    queryKey: ["cancel"],
    queryFn: () => new Promise(() => {}),
  });
  const settled = Promise.allSettled([pending]);
  await client.cancelQueries({ queryKey: ["cancel"] });
  await settled;
  expect(
    toast.getToasts().filter((item): item is ToastT => "title" in item),
  ).toHaveLength(0);
  client.clear();
});

test("a toast retries the failed next page rather than refetching the first page", async () => {
  const client = createQueryClient();
  const requested: number[] = [];
  let fail = true;
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ["paged-transcript"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      requested.push(pageParam);
      if (pageParam === 1 && fail) {
        fail = false;
        throw new Error("Page unavailable");
      }
      return { next: pageParam + 1 };
    },
    getNextPageParam: (page) => page.next,
  });
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().isSuccess).toBe(true),
  );
  await observer.fetchNextPage();
  const notification = toast
    .getToasts()
    .find((item): item is ToastT => "title" in item);
  const action = notification?.action;
  if (!action || typeof action !== "object" || !("onClick" in action))
    throw new Error("Missing retry action");
  action.onClick({} as React.MouseEvent<HTMLButtonElement>);
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data?.pages).toHaveLength(2),
  );
  expect(requested).toEqual([0, 1, 1]);
  unsubscribe();
  client.clear();
});
