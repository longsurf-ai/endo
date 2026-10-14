// Purpose: Shares RPC and live events across app features.

import type { AppRouter } from "@openchart/server/contract";
import {
  createTRPCClient,
  httpLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { EventSource as FetchEventSource, type FetchLike } from "eventsource";
import { Observable, share } from "rxjs";

export type { AgentSessionState } from "@openchart/server/contract";
/** Existing Agent commands, derived from the public transport contract. */
export type AgentInputs = inferRouterInputs<AppRouter>["agent"];
/**
 * Resource results by name. Derive entity types from here: unwrapping a client
 * call with `Awaited<ReturnType<...>>` exceeds TypeScript's instantiation limit
 * for entities that embed an Agent prompt.
 */
export type ResourceOutputs = inferRouterOutputs<AppRouter>["resources"];
/** Resource inputs by name; see {@link ResourceOutputs}. */
export type ResourceInputs = inferRouterInputs<AppRouter>["resources"];
/** Backend Proactive reads, such as prompts suggested beneath an empty chat. */
export type ProactiveOutputs = inferRouterOutputs<AppRouter>["proactive"];
/** One server frame or a local notification that observation must reinitialize. */
export type AppEventFrame =
  | (inferRouterOutputs<AppRouter>["events"]["subscribe"] extends AsyncIterable<
      infer T
    >
      ? T
      : never)
  | { kind: "connecting" };
/** EventSource injection is used by Node integration tests. */
export type TransportOptions = Pick<
  Parameters<typeof httpSubscriptionLink>[0],
  "EventSource"
>;
/** Backend connection supplied by Desktop; isolated tests and demos may omit authentication. */
export interface BackendConnection {
  /** Stable profile identity for optional UI caches; desktop ports and tokens are ephemeral. */
  readonly profileID?: string;
  /** Loopback HTTP origin supplied by Desktop, such as `http://127.0.0.1:52341`. */
  readonly origin: string;
  /** Per-run secret; sent as `Authorization: Bearer` on HTTP and SSE. */
  readonly token?: string;
}

/**
 * Creates lazy RPC access and a ref-counted SSE connection. Late observers receive
 * readiness, never old live events; each feature then reads its own fresh state.
 * The last unsubscribe closes SSE without cancelling backend work.
 * A token is held only in memory here: it never reaches storage, navigation, or logs.
 * @example const transport = createTransport({ origin: location.origin });
 */
export function createTransport(
  connection: BackendConnection,
  options: TransportOptions = {},
) {
  const url = `${connection.origin}/trpc`;
  const headers = connection.token
    ? { authorization: `Bearer ${connection.token}` }
    : undefined;
  // Native EventSource cannot set headers; the fetch-based one can. Node tests still inject their own.
  const authorizedFetch: FetchLike = (input, init) =>
    fetch(input, { ...init, headers: { ...init.headers, ...headers } });
  const rpc = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: httpSubscriptionLink({
          url,
          EventSource:
            options.EventSource ?? (headers ? FetchEventSource : undefined),
          eventSourceOptions: headers ? { fetch: authorizedFetch } : undefined,
        }),
        // Large query filters opt into a body without changing query semantics.
        false: splitLink({
          condition: (operation) => operation.context.method === "POST",
          true: httpLink({ url, headers, methodOverride: "POST" }),
          false: httpLink({ url, headers }),
        }),
      }),
    ],
  });
  let ready = false;
  // Distinguishes a first connection from a lost one for every consumer, whenever it mounts.
  let wasReady = false;
  const shared = new Observable<AppEventFrame>((subscriber) => {
    const subscription = rpc.events.subscribe.subscribe(undefined, {
      onData: (frame) => {
        if (frame.kind === "ready") ready = wasReady = true;
        subscriber.next(frame);
      },
      onConnectionStateChange: (connection) => {
        if (connection.state !== "pending") {
          ready = false;
          subscriber.next({ kind: "connecting" });
        }
      },
      onError: (error) => subscriber.error(error),
      onComplete: () =>
        subscriber.error(new Error("Application event connection ended")),
    });
    return () => {
      ready = false;
      subscription.unsubscribe();
    };
  }).pipe(share());
  const events = new Observable<AppEventFrame>((subscriber) => {
    const alreadyReady = ready;
    const subscription = shared.subscribe(subscriber);
    if (alreadyReady) subscriber.next({ kind: "ready" });
    return subscription;
  });
  return {
    connection,
    url,
    rpc,
    events,
    get ready() {
      return ready;
    },
    /** Whether this transport's event connection was ever ready. */
    get wasReady() {
      return wasReady;
    },
  };
}

/** Application composition shares this exact instance with Agent, Resources and Workspace. */
export type AppTransport = ReturnType<typeof createTransport>;
