// Purpose: Translates one Antigravity CLI turn's stream-json events and host tool calls into AI SDK stream parts.
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { scopedMetadata } from "@openchart/models/provider-protocol";
import type {
  NativeEvent,
  NativeUsage,
  StepUpdate,
  TurnResult,
} from "./events";
import { HOST_SERVER } from "./host-tools";

export type TurnStatus = "completed" | "interrupted" | "error";

export interface TurnTranslatorOptions {
  /** Structured output: only the final `structured_output` is emitted, as one text block. */
  jsonMode: boolean;
  emit(part: LanguageModelV4StreamPart): void;
  /** The CLI announced the conversation that persists this turn. */
  onConversation(conversationId: string): void;
  /** The turn reached a terminal status and every part has been emitted. */
  onFinished(status: TurnStatus): void;
}

type Json = NonNullable<JSONValue>;

const HOST = scopedMetadata(null, { toolExecution: "provider-mcp" });
const HOST_SCHEMAS = `/.gemini/antigravity-cli/mcp/${HOST_SERVER}/`;

function usageOf(usage: NativeUsage): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: usage.input_tokens + usage.cache_read_tokens,
      noCache: usage.input_tokens,
      cacheRead: usage.cache_read_tokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage.output_tokens,
      text: Math.max(0, usage.output_tokens - usage.thinking_tokens),
      reasoning: usage.thinking_tokens,
    },
  };
}

function add(total: NativeUsage, step: NativeUsage): NativeUsage {
  return {
    input_tokens: total.input_tokens + step.input_tokens,
    output_tokens: total.output_tokens + step.output_tokens,
    thinking_tokens: total.thinking_tokens + step.thinking_tokens,
    cache_read_tokens: total.cache_read_tokens + step.cache_read_tokens,
  };
}

/**
 * The CLI calls OpenChart tools through `call_mcp_tool` after reading their
 * schema files; the host server reports those calls itself, so these steps
 * are plumbing and never shown. A denied call ends the turn with
 * `denied_actions`, which the result reports as an error.
 */
function isHostPlumbing(step: StepUpdate): boolean {
  const parameters = step.tool_info?.parameters ?? {};
  const name = step.tool_info?.name ?? step.tool_name;
  if (name === "call_mcp_tool") return parameters.ServerName === HOST_SERVER;
  return (
    name === "view_file" &&
    typeof parameters.AbsolutePath === "string" &&
    parameters.AbsolutePath.includes(HOST_SCHEMAS)
  );
}

/**
 * Capability layer for one turn. Root text streams from `agent_response`
 * deltas; each `tool` step becomes a provider-executed call and result. Native
 * subagents run as background conversations whose steps never reach this
 * stream, so `invoke_subagent` stays an ordinary tool call. OpenChart tool
 * calls arrive from the host server with their exact outcomes. Usage sums the
 * turn's own steps because the result's usage spans a resumed conversation.
 * @example
 * const translator = new TurnTranslator(options);
 * for (const event of events) translator.handle(event);
 */
export class TurnTranslator {
  private readonly texts = new Map<number, string>();
  private readonly tools = new Map<number, { id: string; name: string }>();
  private readonly hostCalls = new Map<string, string>();
  private usage: NativeUsage | undefined;
  private interrupted = false;
  private done = false;

  constructor(private readonly options: TurnTranslatorOptions) {}

  private emit(part: LanguageModelV4StreamPart): void {
    this.options.emit(part);
  }

  /** The caller asked the CLI to stop; the terminal result becomes an interruption. */
  markInterrupted(): void {
    this.interrupted = true;
  }

  handle(event: NativeEvent): void {
    if (this.done) return;
    switch (event.event) {
      case "init":
        return this.options.onConversation(event.conversation_id);
      case "step_update":
        return this.step(event.step_update);
      case "result":
        return this.result(event.result);
    }
  }

  /** Ends the turn when the CLI exits without a result. */
  end(detail: string): void {
    if (this.done) return;
    if (!this.interrupted)
      this.emit({
        type: "error",
        error: new Error(
          `Antigravity stopped without a result${detail ? `: ${detail}` : ""}`,
        ),
      });
    this.finish(this.interrupted ? "interrupted" : "error", {
      unified: "error",
      raw: "exited",
    });
  }

  // OpenChart tools, reported by the host server.

  hostToolStarted(id: string, name: string, input: unknown): void {
    if (this.done) return;
    this.hostCalls.set(id, name);
    this.toolCall(id, name, input, HOST);
  }

  hostToolFinished(
    id: string,
    name: string,
    output: unknown,
    isError: boolean,
  ): void {
    if (this.done || !this.hostCalls.delete(id)) return;
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      result: (output ?? "") as Json,
      dynamic: true,
      ...(isError ? { isError: true } : {}),
      ...HOST,
    });
  }

  // Native steps

  private step(step: StepUpdate): void {
    if (step.usage && step.state !== "ACTIVE")
      this.usage = this.usage ? add(this.usage, step.usage) : step.usage;
    if (step.step_type === "agent_response") this.response(step);
    else if (step.step_type === "tool") this.tool(step);
  }

  private response(step: StepUpdate): void {
    if (step.text_delta && !this.options.jsonMode) {
      let id = this.texts.get(step.step_index);
      if (!id) {
        id = generateId();
        this.texts.set(step.step_index, id);
        this.emit({ type: "text-start", id });
      }
      this.emit({ type: "text-delta", id, delta: step.text_delta });
    }
    if (step.state !== "ACTIVE") this.endText(step.step_index);
  }

  private endText(index: number): void {
    const id = this.texts.get(index);
    if (!id) return;
    this.texts.delete(index);
    this.emit({ type: "text-end", id });
  }

  private tool(step: StepUpdate): void {
    if (isHostPlumbing(step)) return;
    const terminal = step.state !== "ACTIVE";
    const failed =
      step.state === "ERROR" || step.tool_info?.error !== undefined;
    const name = step.tool_info?.name ?? step.tool_name ?? "tool";
    let open = this.tools.get(step.step_index);
    if (!open) {
      open = { id: generateId(), name };
      this.tools.set(step.step_index, open);
      const subagents = step.subagent_info?.subagents.map(
        ({ role, initial_prompt }) => ({ role, prompt: initial_prompt }),
      );
      this.toolCall(
        open.id,
        name,
        subagents ? { subagents } : (step.tool_info?.parameters ?? {}),
      );
    }
    if (!terminal) return;
    this.tools.delete(step.step_index);
    this.emit({
      type: "tool-result",
      toolCallId: open.id,
      toolName: open.name,
      result: (step.tool_info?.error?.message ??
        step.tool_info?.output ??
        step.subagent_info ??
        "") as Json,
      dynamic: true,
      ...(failed ? { isError: true } : {}),
    });
  }

  private toolCall(
    id: string,
    name: string,
    input: unknown,
    owner: ReturnType<typeof scopedMetadata> = {},
  ): void {
    this.emit({
      type: "tool-input-start",
      id,
      toolName: name,
      providerExecuted: true,
      dynamic: true,
      ...owner,
    });
    this.emit({ type: "tool-input-end", id, ...owner });
    this.emit({
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(input ?? {}),
      providerExecuted: true,
      dynamic: true,
      ...owner,
    });
  }

  // Terminal

  private result(result: TurnResult): void {
    this.usage ??= result.usage;
    const denied = result.denied_actions ?? [];
    if (result.status === "SUCCESS" && denied.length > 0) {
      // The CLI stopped at an action it could not ask about; say so instead of ending silently.
      if (!this.interrupted)
        this.emit({
          type: "error",
          error: new Error(
            `Antigravity stopped because it cannot ask for permission here: ${denied
              .map((action) => `${action.display_name} (${action.action})`)
              .join(
                ", ",
              )}. Allow these in Antigravity's settings, or set Permissions to Always allow.`,
          ),
        });
      this.finish(this.interrupted ? "interrupted" : "error", {
        unified: "error",
        raw: "denied",
      });
      return;
    }
    if (result.status === "SUCCESS") {
      if (this.options.jsonMode) {
        const json =
          result.structured_output === undefined
            ? result.response
            : JSON.stringify(result.structured_output);
        if (json) this.wholeText(json);
      }
      this.finish(this.interrupted ? "interrupted" : "completed", {
        unified: "stop",
        raw: result.status,
      });
      return;
    }
    if (!this.interrupted)
      this.emit({
        type: "error",
        error: new Error(result.error || `Antigravity turn ${result.status}`),
      });
    this.finish(this.interrupted ? "interrupted" : "error", {
      unified: "error",
      raw: result.status,
    });
  }

  private wholeText(text: string): void {
    const id = generateId();
    this.emit({ type: "text-start", id });
    this.emit({ type: "text-delta", id, delta: text });
    this.emit({ type: "text-end", id });
  }

  private finish(
    status: TurnStatus,
    reason: LanguageModelV4FinishReason,
  ): void {
    if (this.done) return;
    for (const index of [...this.texts.keys()]) this.endText(index);
    for (const [index, open] of this.tools) {
      this.tools.delete(index);
      this.emit({
        type: "tool-result",
        toolCallId: open.id,
        toolName: open.name,
        result: { status },
        dynamic: true,
        isError: true,
      });
    }
    for (const [id, name] of this.hostCalls)
      this.hostToolFinished(id, name, { status }, true);
    this.emit({
      type: "finish",
      finishReason:
        status === "interrupted"
          ? { unified: "stop", raw: "interrupted" }
          : reason,
      usage: usageOf(
        this.usage ?? {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
        },
      ),
    });
    this.done = true;
    this.options.onFinished(status);
  }
}
