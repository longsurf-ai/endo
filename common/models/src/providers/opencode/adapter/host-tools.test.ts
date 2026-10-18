// Purpose: Verifies loopback authentication, invalid calls and exact host outcome ownership.
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { startHostToolServer } from "./host-tools";

it("rejects unauthenticated and invalid MCP calls before executing a host tool", async () => {
  const execute = vi.fn(async () => "ok");
  const calls = { started: vi.fn(), finished: vi.fn() };
  const host = await startHostToolServer(
    {
      check: {
        description: "Synthetic check",
        inputSchema: z.object({ token: z.literal("expected") }),
        execute,
        toModelOutput: (value) => value,
      },
    },
    undefined,
    calls,
  );
  const headers = Object.fromEntries(
    host.server.headers.map(({ name, value }) => [name, value]),
  );
  const post = (body: string, authenticated = true) =>
    fetch(host.server.url, {
      method: "POST",
      headers: authenticated ? headers : {},
      body,
    });
  const call = (name: string, input: unknown) =>
    post(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: input },
      }),
    );
  try {
    expect((await post("{}", false)).status).toBe(401);
    expect((await post("not JSON")).status).toBe(400);
    expect(await (await call("missing", {})).json()).toMatchObject({
      result: { isError: true },
    });
    expect(
      await (await call("check", { token: "wrong" })).json(),
    ).toMatchObject({ result: { isError: true } });
    expect(execute).not.toHaveBeenCalled();
    expect(calls.finished).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "check",
      expect.any(String),
      true,
    );
  } finally {
    await host.close();
  }
});

it("reports the original host result once when model projection fails", async () => {
  const outcome = { privateRevision: 42 };
  const calls = { started: vi.fn(), finished: vi.fn() };
  const host = await startHostToolServer(
    {
      check: {
        description: "Synthetic projection failure",
        inputSchema: z.object({}),
        execute: async () => outcome,
        toModelOutput: () => {
          throw new Error("Projection failed");
        },
      },
    },
    undefined,
    calls,
  );
  try {
    const response = await fetch(host.server.url, {
      method: "POST",
      headers: Object.fromEntries(
        host.server.headers.map(({ name, value }) => [name, value]),
      ),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "check" },
      }),
    });
    expect(await response.json()).toMatchObject({
      result: { isError: true, content: [{ text: "Projection failed" }] },
    });
    expect(calls.finished).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "check",
      outcome,
      false,
    );
  } finally {
    await host.close();
  }
});
