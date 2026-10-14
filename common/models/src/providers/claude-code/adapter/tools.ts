// Purpose: Exposes OpenChart tools to Claude as one in-process MCP server and records each exact outcome by tool use ID.
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ZodObject, ZodRawShape, ZodType } from "zod";

export const HOST_SERVER = "openchart";
/** Claude names MCP tools `mcp__<server>__<tool>`; the stream uses the bare tool name. */
export const HOST_TOOL_PREFIX = `mcp__${HOST_SERVER}__`;
/** OpenChart owns tool timeouts; the CLI's MCP client deadline is only a backstop. */
export const HOST_TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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

/** Exact application outcome of an OpenChart tool this request executed. */
export interface ToolOutcome {
  output: unknown;
  isError: boolean;
}

export interface HostToolServer {
  server: McpSdkServerConfigWithInstance;
  /** Native tool names to auto-allow; OpenChart already authorized these tools. */
  allowedTools: string[];
  /** Consumes the recorded outcome for a tool use, if this request ran it. */
  takeOutcome(toolUseId: string): ToolOutcome | undefined;
}

function toolUseId(extra: unknown): string | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)
    ?._meta;
  const id = meta?.["claudecode/toolUseId"];
  return typeof id === "string" ? id : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/**
 * The CLI calls these tools over its control channel with the model's tool use
 * ID in `_meta`, so each exact outcome is keyed by the same ID the stream later
 * reports. The model reads only `toModelOutput`. Without an ID the tool still
 * runs; the stream then carries the native echo instead of the exact outcome.
 * @example
 * const host = createHostToolServer(tools, abortSignal);
 * query({ prompt, options: { mcpServers: { [HOST_SERVER]: host.server }, allowedTools: host.allowedTools } });
 */
export function createHostToolServer(
  tools: Record<string, HostTool>,
  abortSignal: AbortSignal | undefined,
): HostToolServer {
  const outcomes = new Map<string, ToolOutcome>();
  const server = createSdkMcpServer({
    name: HOST_SERVER,
    tools: Object.entries(tools).map(([name, definition]) =>
      tool(
        name,
        definition.description,
        (definition.inputSchema as ZodObject<ZodRawShape>).shape,
        async (args, extra) => {
          const id = toolUseId(extra);
          try {
            const output = await definition.execute(args, {
              toolCallId: id ?? name,
              abortSignal,
            });
            if (id) outcomes.set(id, { output, isError: false });
            return {
              content: [
                { type: "text", text: text(definition.toModelOutput(output)) },
              ],
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (id) outcomes.set(id, { output: message, isError: true });
            return {
              content: [{ type: "text", text: message }],
              isError: true,
            };
          }
        },
      ),
    ),
  });
  return {
    server,
    allowedTools: Object.keys(tools).map(
      (name) => `${HOST_TOOL_PREFIX}${name}`,
    ),
    takeOutcome(id) {
      const outcome = outcomes.get(id);
      outcomes.delete(id);
      return outcome;
    },
  };
}
