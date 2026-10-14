// Purpose: Resolve only bundled renderer files and SPA document routes at the desktop origin.

import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

/** The desktop's local application origin; it never resolves over the network. */
export const origin = "reagent://app";

/**
 * Resolves a permitted asset or SPA document request inside the renderer bundle.
 * Missing assets, foreign origins, unsupported methods, and escaping paths
 * return undefined. Filesystem failures other than missing paths propagate.
 * @example
 * const file = await resolveAsset('/bundle/renderer', new Request(
 *   'reagent://app/app', {headers: {accept: 'text/html'}},
 * ));
 */
export async function resolveAsset(
  directory: string,
  request: Request,
  applicationOrigin = origin,
): Promise<string | undefined> {
  const url = new URL(request.url);
  const expected = new URL(applicationOrigin);
  if (
    url.protocol !== expected.protocol ||
    url.host !== expected.host ||
    !["GET", "HEAD"].includes(request.method)
  )
    return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (cause) {
    if (cause instanceof URIError) return undefined;
    throw cause;
  }
  const file = resolve(directory, `.${pathname}`);
  const path = relative(directory, file);
  if (path.startsWith("..") || isAbsolute(path) || pathname.includes("\0"))
    return undefined;
  const entry = await stat(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return undefined;
    throw cause;
  });
  if (entry?.isFile()) return file;
  if (
    pathname !== "/api" &&
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/assets/") &&
    (request.headers.get("accept")?.includes("text/html") ||
      // HEAD probes of document routes read the same security headers.
      (request.method === "HEAD" && !extname(pathname)))
  )
    return resolve(directory, "index.html");
  return undefined;
}
