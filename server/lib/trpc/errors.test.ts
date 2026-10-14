// Purpose: Verify shared error policy across ordinary HTTP routes and late SSE failures.

import { temporaryHome } from "@openchart/server/home.test-utils";

import { once } from "node:events";
import { createServer } from "node:http";
import { makeRuntime } from "@openchart/server/runtime";
import {
  ResourceNotFound,
  ResourceStateInvalid,
  RevisionConflict,
} from "@openchart/server/lib/resource/errors";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { ConfigProvider } from "effect";
import { expect, test, vi } from "vitest";
import { z } from "zod";

import { trpc } from "./trpc";

test("applies one public policy to any HTTP route, input failure, and late subscription error", async () => {
  const secret = new Error("private database connection details");
  let cause: Error = secret;
  const router = trpc.router({
    operation: trpc.procedure.input(z.object({ key: z.string() })).query(() => {
      throw cause;
    }),
    late: trpc.procedure.subscription(async function* () {
      yield "connected";
      throw cause;
    }),
  });
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  const server = createServer(
    createHTTPHandler({
      router,
      createContext: () => ({ runtime }),
    }),
  );
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No server port");
    const base = `http://127.0.0.1:${address.port}`;
    const input = encodeURIComponent(JSON.stringify({ key: "x" }));
    for (const expected of [
      {
        cause: new ResourceNotFound({ resource: "example", id: "exm_1" }),
        status: 404,
        text: "example exm_1 not found",
      },
      {
        cause: new RevisionConflict({
          resource: "example",
          id: "exm_1",
          expected: 1,
          actual: 2,
        }),
        status: 409,
        text: "is at revision 2, expected 1",
      },
      {
        cause: new ResourceStateInvalid({
          resource: "example",
          reason: "Invalid name",
          issues: [],
        }),
        status: 400,
        text: "resourceStateInvalid",
      },
      { cause: secret, status: 500, text: "Internal server error" },
    ]) {
      cause = expected.cause;
      const response = await fetch(`${base}/operation?input=${input}`);
      expect(response.status).toBe(expected.status);
      const body = await response.text();
      expect(body).toContain(expected.text);
      expect(body).not.toContain(secret.message);
      expect(body).not.toContain('"stack"');
      expect(body).not.toContain('"cause"');
    }
    const invalid = await fetch(`${base}/operation?input=%7B%7D`);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Invalid request");
    const missing = await fetch(`${base}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('"stack"');

    // A subscription succeeds initially; its later failure bypasses unary middleware.
    const stream = await fetch(`${base}/late`);
    expect(stream.status).toBe(200);
    const events = await stream.text();
    expect(events).toContain("connected");
    expect(events).toContain("Internal server error");
    expect(events).not.toContain(secret.message);
    expect(events).not.toContain('"stack"');
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith("Server request failed", secret);
  } finally {
    logged.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.dispose();
  }
});
