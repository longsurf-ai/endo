// Purpose: Exercise the actual SSE boundary and release its scoped filesystem resources.
import { once } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { FSWatcher } from "chokidar";
import { expect, test, vi } from "vitest";
import { router } from "@openchart/server";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime } from "@openchart/server/runtime";

test("one SSE connection shares a shallow watcher and disconnect releases it", async () => {
  const home = await realpath(temporaryHome());
  const runtime = makeRuntime({
    home,
    databasePath: ":memory:",
    models: { fetchEnabled: false, userAgent: "workspace-sse-test" },
  });
  const server = createServer(
    createHTTPHandler({ router, createContext: () => ({ runtime }) }),
  );
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const client = router.createCaller({ runtime });
    const root = join(home, "files");
    await mkdir(root);
    await writeFile(join(root, "main.tea"), "close");
    const workspace = await client.resources.workspace.register({ root });
    const watch = vi.spyOn(FSWatcher.prototype, "add");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP port");
    const input = {
      interests: [
        { workspaceId: workspace.id, target: { kind: "directory", path: "" } },
        {
          workspaceId: workspace.id,
          target: { kind: "file", path: "main.tea" },
        },
      ],
    };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/workspace.watch?input=${encodeURIComponent(JSON.stringify(input))}`,
      { signal: controller.signal },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("Missing SSE body");
    const reader = response.body.getReader();
    let body = "";
    const decoder = new TextDecoder();
    const readThrough = async (count: number) => {
      while ((body.match(/"workspaceId"/g) ?? []).length < count) {
        const next = await reader.read();
        if (next.done) throw new Error("SSE ended early");
        body += decoder.decode(next.value, { stream: true });
      }
    };
    // Each interest receives its initial invalidation and watcher-ready refresh.
    await readThrough(4);
    expect(watch).toHaveBeenCalledOnce();
    const watcher = watch.mock.results[0]!.value as FSWatcher;
    const close = vi.spyOn(watcher, "close");
    await writeFile(join(root, "main.tea"), "open");
    await readThrough(6);
    expect(body).toContain('"kind":"directory"');
    expect(body).toContain('"kind":"file"');
    expect(
      await client.workspace.read({
        workspaceId: workspace.id,
        path: "main.tea",
      }),
    ).toMatchObject({ base64: Buffer.from("open").toString("base64") });
    await reader.cancel();
    controller.abort();
    await expect.poll(() => close.mock.calls.length).toBe(1);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.dispose();
    vi.restoreAllMocks();
  }
});
