// Purpose: Serves OpenChart tools to one Grok session as a loopback HTTP MCP server.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { generateId } from "@ai-sdk/provider-utils";
import { z, type ZodType } from "zod";

/** MCP server name Grok sees; its catalog keys are `openchart__<tool>`. */
export const HOST_SERVER = "openchart";
/** Prefix of OpenChart catalog keys in Grok's `use_tool` calls. */
export const HOST_TOOL_PREFIX = `${HOST_SERVER}__`;
/** Largest JSON-RPC body accepted from the agent. */
const BODY_LIMIT = 16 * 1024 * 1024;

/** Shape-only view of an OpenChart tool; the binding supplies the real definitions. */
export interface HostTool {
  description: string;
  inputSchema: ZodType;
  execute(
    input: unknown,
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<unknown>;
  toModelOutput(output: unknown): unknown;
}

/** Receives each OpenChart tool call as it starts and its exact outcome when it ends. */
export interface HostToolCalls {
  started(id: string, name: string, input: unknown): void;
  finished(id: string, name: string, output: unknown, isError: boolean): void;
}

export interface HostToolServer {
  /** The ACP `mcpServers` entry for `session/new` and `session/resume`. */
  server: {
    type: "http";
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  };
  /** Stops listening and drops open connections. Idempotent. */
  close(): void;
}

const Message = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
const InitializeParams = z.looseObject({ protocolVersion: z.string() });
const CallParams = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

type Reply = { result: unknown } | { error: { code: number; message: string } };

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("MCP request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Listens on an ephemeral loopback port for one request. Grok connects with
 * the request's random bearer token; other requests get 401. It speaks MCP's
 * streamable HTTP transport with JSON responses only: `initialize`, `ping`,
 * `tools/list` and `tools/call`. Each call runs `execute` in-process; the model
 * reads only `toModelOutput`, and `calls` receives the exact outcome.
 * @example
 * const host = await startHostToolServer(tools, signal, calls);
 * try { await acp.request("session/new", { cwd, mcpServers: [host.server] }); } finally { host.close(); }
 */
export async function startHostToolServer(
  tools: Record<string, HostTool>,
  abortSignal: AbortSignal | undefined,
  calls: HostToolCalls,
): Promise<HostToolServer> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const sockets = new Set<Socket>();
  const listed = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
  }));

  async function callTool(params: unknown) {
    const { name, arguments: input = {} } = CallParams.parse(params);
    const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (!tool)
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    const id = generateId();
    calls.started(id, name, input);
    try {
      const output = await tool.execute(input, { toolCallId: id, abortSignal });
      calls.finished(id, name, output, false);
      return {
        content: [{ type: "text", text: text(tool.toModelOutput(output)) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      calls.finished(id, name, message, true);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  async function reply(method: string, params: unknown): Promise<Reply> {
    switch (method) {
      case "initialize":
        return {
          result: {
            protocolVersion:
              InitializeParams.safeParse(params).data?.protocolVersion ??
              "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: HOST_SERVER, version: "1.0.0" },
          },
        };
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: listed } };
      case "tools/call":
        try {
          return { result: await callTool(params) };
        } catch (error) {
          return {
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      default:
        return { error: { code: -32601, message: `Unknown method ${method}` } };
    }
  }

  function authorized(request: IncomingMessage): boolean {
    const received = Buffer.from(request.headers.authorization ?? "");
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    // Sessions end with DELETE; the server keeps no session state.
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    // No server-initiated stream: every reply travels in its POST response.
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    let message: z.infer<typeof Message> | undefined;
    try {
      message = Message.safeParse(JSON.parse(await readBody(request))).data;
    } catch {
      message = undefined;
    }
    if (!message) {
      response.writeHead(400).end();
      return;
    }
    // Responses and notifications need no answer.
    if (message.method === undefined || message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const answer = await reply(message.method, message.params);
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer });
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      })
      .end(body);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server: {
      type: "http",
      name: HOST_SERVER,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
