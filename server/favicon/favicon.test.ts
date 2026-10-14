// Purpose: Keep favicon reads optional and restricted to the fixed image provider.
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { favicon } from "./favicon";

afterEach(() => vi.unstubAllGlobals());

it("returns a canvas-safe image and never follows an upstream redirect", async () => {
  const request = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([0, 1, 2]), {
      headers: { "content-type": "image/x-icon" },
    }),
  );
  vi.stubGlobal("fetch", request);
  expect(await Effect.runPromise(favicon("www.apple.com"))).toBe(
    "data:image/x-icon;base64,AAEC",
  );
  expect(request).toHaveBeenCalledWith(
    "https://icons.duckduckgo.com/ip3/www.apple.com.ico",
    { signal: expect.any(AbortSignal), redirect: "error" },
  );
});

it("leaves missing, non-image and failed requests to the letter fallback", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      new Response("<html>blocked</html>", {
        headers: { "content-type": "text/html" },
      }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", request);
  for (let i = 0; i < 3; i++)
    expect(await Effect.runPromise(favicon("example.com"))).toBeNull();
});
