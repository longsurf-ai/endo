// Purpose: Verify bounded optional metadata and connection-level fallback.
import { createServer, type RequestListener } from "node:http";
import { Effect } from "effect";
import { DefaultRequestFilteringAgentOptions } from "request-filtering-agent";
import { afterEach, expect, it, vi } from "vitest";
import { linkPreview } from "@openchart/server/agent/link-preview/link-preview";

const closeServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  DefaultRequestFilteringAgentOptions.allowIPAddressList = [];
  await Promise.all(closeServers.splice(0).map((close) => close()));
});

async function fixture(handler: RequestListener, allowLocal = true) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeServers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  if (allowLocal)
    DefaultRequestFilteringAgentOptions.allowIPAddressList = ["127.0.0.1"];
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}

it("decodes HTML metadata, prefers Open Graph and ignores script/comment/body lookalikes", async () => {
  const url = await fixture((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<html><head>
      <!-- <meta property="og:title" content="Comment"> -->
      <script>const text = '<meta property="og:title" content="Script">';</script>
      <title>Document title</title>
      <meta NAME="description" CONTENT="Basic description">
      <meta CONTENT="  € revenue &amp; profit  " PROPERTY="og:title">
      <meta property="og:description" content="First&#10; second &quot;quote&quot;">
      </head><body><meta property="og:title" content="Body"></body></html>`);
  });
  expect(await Effect.runPromise(linkPreview(url))).toEqual({
    title: "€ revenue & profit",
    description: 'First second "quote"',
  });
});

it("falls back to title/description and permits missing metadata", async () => {
  const url = await fixture((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      request.url === "/empty"
        ? "<html></html>"
        : '<title> A &amp; B </title><meta name="description" content=" Summary ">',
    );
  });
  expect(await Effect.runPromise(linkPreview(url))).toEqual({
    title: "A & B",
    description: "Summary",
  });
  expect(await Effect.runPromise(linkPreview(`${url}/empty`))).toEqual({
    title: null,
    description: null,
  });
});

it("follows relative redirects but bounds loops and rejects private redirect destinations", async () => {
  const requests: string[] = [];
  const url = await fixture((request, response) => {
    requests.push(request.url!);
    if (request.url === "/article") {
      response.setHeader("content-type", "text/html");
      response.end("<title>Article</title>");
    } else {
      response.writeHead(302, {
        location:
          request.url === "/private"
            ? "http://127.0.0.2/"
            : request.url === "/loop"
              ? "/loop"
              : "/article",
      });
      response.end();
    }
  });
  expect(await Effect.runPromise(linkPreview(url))).toEqual({
    title: "Article",
    description: null,
  });
  expect(await Effect.runPromise(linkPreview(`${url}/private`))).toBeNull();
  expect(await Effect.runPromise(linkPreview(`${url}/loop`))).toBeNull();
  expect(requests.filter((path) => path === "/loop")).toHaveLength(4);
});

it.each(["file:///etc/passwd", "http://["])(
  "rejects redirect destination %s",
  async (location) => {
    const url = await fixture((_request, response) => {
      response.writeHead(302, { location });
      response.end();
    });
    expect(await Effect.runPromise(linkPreview(url))).toBeNull();
  },
);

it("closes an unfinished redirect response when the preview ends", async () => {
  const closed = vi.fn();
  const url = await fixture((request, response) => {
    if (request.url === "/article") {
      response.setHeader("content-type", "text/html");
      response.end("<title>Article</title>");
      return;
    }
    response.on("close", closed);
    response.writeHead(302, { location: "/article" });
    response.flushHeaders();
  });
  expect(await Effect.runPromise(linkPreview(url))).toEqual({
    title: "Article",
    description: null,
  });
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
});

it("returns null for failures, non-HTML, oversized heads and invalid destinations", async () => {
  const url = await fixture((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/blocked") response.statusCode = 403;
    if (request.url === "/image")
      response.setHeader("content-type", "image/png");
    if (request.url === "/charset")
      response.setHeader("content-type", "text/html; charset=invalid");
    if (request.url === "/encoded")
      response.setHeader("content-encoding", "gzip");
    if (request.url === "/declared") {
      response.setHeader("content-length", 600_000);
      response.end("a".repeat(600_000));
      return;
    }
    if (request.url === "/streamed") {
      response.write("a".repeat(300_000));
      response.end("b".repeat(300_000));
    } else response.end("<title>Unavailable</title>");
  });
  for (const path of [
    "blocked",
    "image",
    "charset",
    "encoded",
    "declared",
    "streamed",
  ])
    expect(await Effect.runPromise(linkPreview(`${url}/${path}`))).toBeNull();
  for (const target of [
    "file:///etc/passwd",
    "ftp://example.com",
    "https://user:pass@example.com",
    "invalid",
  ])
    expect(await Effect.runPromise(linkPreview(target))).toBeNull();
});

it("stops at the head byte limit without waiting for another chunk", async () => {
  const closed = vi.fn();
  const url = await fixture((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.on("close", closed);
    response.write("a".repeat(512 * 1024));
  });
  expect(await Effect.runPromise(linkPreview(url))).toBeNull();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
}, 2_000);

it("reads metadata before a large declared or streaming body and immediately closes the response", async () => {
  const closed = vi.fn();
  const url = await fixture((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/declared")
      response.setHeader("content-length", 1_500_000);
    response.on("close", closed);
    response.write(
      '<html><head><title>Large page</title><meta name="description" content="Useful summary"></head><body>',
    );
    // The body deliberately never finishes: metadata must not wait for it.
  });
  for (const path of ["declared", "streamed"]) {
    expect(await Effect.runPromise(linkPreview(`${url}/${path}`))).toEqual({
      title: "Large page",
      description: "Useful summary",
    });
  }
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(2));
});

it("blocks loopback IPs and DNS names with the real filtering agent", async () => {
  const received = vi.fn<RequestListener>((_request, response) =>
    response.end("private"),
  );
  const url = await fixture(received, false);
  for (const target of [
    url,
    url.replace("127.0.0.1", "localhost"),
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    url.replace("http:", "https:"),
    "https://[::1]/",
  ])
    expect(await Effect.runPromise(linkPreview(target))).toBeNull();
  expect(received).not.toHaveBeenCalled();
});

it("times out a stalled response and closes it", async () => {
  const closed = vi.fn();
  const url = await fixture((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.flushHeaders();
    response.on("close", closed);
  });
  expect(await Effect.runPromise(linkPreview(url))).toBeNull();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
}, 10_000);

it("cancels the active socket when the hover request is abandoned", async () => {
  const controller = new AbortController();
  const closed = vi.fn();
  const url = await fixture((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.flushHeaders();
    response.on("close", closed);
    controller.abort();
  });
  await expect(
    Effect.runPromise(linkPreview(url), { signal: controller.signal }),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
});
