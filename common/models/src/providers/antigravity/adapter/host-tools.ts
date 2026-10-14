// Purpose: Serves OpenChart tools to the Antigravity CLI as one MCP server, reached through a fixed stdio relay.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { generateId } from "@ai-sdk/provider-utils";
import { z, type ZodType } from "zod";

/** MCP server name the CLI sees; its tools are `openchart/<tool>`. */
export const HOST_SERVER = "openchart";
/** Environment the relay reads to reach this request's server. */
export const RELAY_PORT = "OPENCHART_AGY_MCP_PORT";
export const RELAY_TOKEN = "OPENCHART_AGY_MCP_TOKEN";

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
  /** Variables for the CLI process; its relay connects with them. */
  env: Record<string, string>;
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

function parseMessage(line: string) {
  try {
    return Message.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/**
 * Listens on an ephemeral loopback port for this request only. The relay must
 * send the request's random token as its first line; other connections are
 * dropped. Then it speaks newline-delimited MCP JSON-RPC: `initialize`,
 * `ping`, `tools/list` and `tools/call`. Each call runs `execute` in-process;
 * the model reads only `toModelOutput`, and `calls` receives the exact outcome.
 * @example
 * const host = await startHostToolServer(tools, signal, calls);
 * try { spawn(executable, args, { env: { ...env, ...host.env } }); } finally { host.close(); }
 */
export async function startHostToolServer(
  tools: Record<string, HostTool>,
  abortSignal: AbortSignal | undefined,
  calls: HostToolCalls,
): Promise<HostToolServer> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token);
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

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let authorized = false;
    createInterface({ input: socket, crlfDelay: Infinity }).on(
      "line",
      (line) => {
        if (!authorized) {
          const received = Buffer.from(line.trim());
          authorized =
            received.length === expected.length &&
            timingSafeEqual(received, expected);
          if (!authorized) socket.destroy();
          return;
        }
        const message = parseMessage(line);
        // Responses and notifications need no answer.
        if (message?.method === undefined || message.id === undefined) return;
        const { id, method, params } = message;
        void reply(method, params).then((answer) => {
          if (!socket.destroyed)
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id, ...answer })}\n`,
            );
        });
      },
    );
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
    env: { [RELAY_PORT]: String(port), [RELAY_TOKEN]: token },
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
