// Purpose: Read optional website icons without persisting derived presentation data.
import { Effect } from "effect";

/** Return a canvas-safe image from one fixed icon provider; unavailable icons remain initials.
 * @example const icon = yield* favicon("www.apple.com");
 */
export const favicon = Effect.fn("Favicon.get")((hostname: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`,
      { signal, redirect: "error" },
    );
    const type = response.headers.get("content-type")?.split(";")[0];
    if (
      !response.ok ||
      !type ||
      !/^image\/(?:x-icon|vnd\.microsoft\.icon|png|jpeg|gif|webp)$/.test(type)
    ) {
      await response.body?.cancel();
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length
      ? `data:${type};base64,${bytes.toString("base64")}`
      : null;
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(null)),
  ),
);
