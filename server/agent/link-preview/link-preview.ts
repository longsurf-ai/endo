// Purpose: Read bounded, optional public-page metadata without a browser or cache.
import { NodeHttpClient } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientResponse, Url } from "effect/unstable/http";
import { Parser } from "htmlparser2";
import {
  RequestFilteringHttpAgent,
  RequestFilteringHttpsAgent,
} from "request-filtering-agent";

const MAX_BYTES = 512 * 1024;

const metadata = Effect.fn("LinkPreview.metadata")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  let title = "";
  let inTitle = false;
  let headComplete = false;
  const tags = new Map<string, string>();
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "title") inTitle = true;
      if (name !== "meta") return;
      const key = (attributes.property ?? attributes.name)?.toLowerCase();
      if (key && attributes.content?.trim() && !tags.has(key))
        tags.set(key, attributes.content);
    },
    ontext(text) {
      if (inTitle) title += text;
    },
    onclosetag(name) {
      if (name === "title") inTitle = false;
      if (name === "head") {
        headComplete = true;
        parser.pause();
      }
    },
  });
  const charset = response.headers["content-type"]?.match(
    /charset=["']?([^\s;"']+)/i,
  )?.[1];
  const decoder = yield* Effect.try(() => new TextDecoder(charset ?? "utf-8"));
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (chunk) =>
    Effect.try(() => {
      const bounded = chunk.subarray(0, MAX_BYTES - size);
      size += bounded.length;
      parser.write(decoder.decode(bounded, { stream: true }));
      return !headComplete && size < MAX_BYTES;
    }),
  );
  if (!headComplete && size >= MAX_BYTES) return null;
  yield* Effect.try(() => parser.end(decoder.decode()));
  const clean = (value: string, limit: number) =>
    value.replace(/\s+/g, " ").trim().slice(0, limit) || null;
  return {
    title: clean(tags.get("og:title") ?? title, 300),
    description: clean(
      tags.get("og:description") ?? tags.get("description") ?? "",
      1000,
    ),
  };
});

/**
 * Read public HTTP(S) metadata on demand. All fetch failures become null;
 * callers keep the original link. Credentialed links are rejected. Requests
 * follow at most three redirects, reject private/reserved destinations at
 * connection time, and stop after five seconds or 512 KiB of the head. Stops
 * reading at </head>, regardless of the body size. Every hop's socket closes
 * when the read ends or is cancelled. Nothing is persisted.
 * @example const preview = yield* linkPreview("https://example.com/article");
 */
export const linkPreview = Effect.fn("LinkPreview.get")(
  function* (value: string) {
    const url = yield* Effect.fromResult(Url.fromString(value));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const agents = yield* Effect.acquireRelease(
      Effect.sync(() => ({
        http: new RequestFilteringHttpAgent({ keepAlive: false }),
        https: new RequestFilteringHttpsAgent({ keepAlive: false }),
      })),
      ({ http, https }) =>
        Effect.sync(() => {
          http.destroy();
          https.destroy();
        }),
    );
    // withScope sits inside followRedirects so every hop's request is scoped.
    const client = (yield* NodeHttpClient.makeNodeHttp.pipe(
      Effect.provideService(NodeHttpClient.HttpAgent, agents),
    )).pipe(HttpClient.withScope, HttpClient.followRedirects(3));
    const response = yield* client.get(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
        "user-agent": "OpenChart-LinkPreview/1.0",
      },
    });
    const { status, headers } = response;
    if (
      status < 200 ||
      status >= 300 ||
      !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
        headers["content-type"] ?? "",
      ) ||
      (headers["content-encoding"] &&
        headers["content-encoding"] !== "identity")
    )
      return null;
    return yield* metadata(response);
  },
  Effect.scoped,
  Effect.timeout("5 seconds"),
  Effect.catch(() => Effect.succeed(null)),
  // Unparseable redirect locations and non-HTTP redirect schemes throw inside
  // the client; they are still just "no preview".
  Effect.catchDefect(() => Effect.succeed(null)),
);
