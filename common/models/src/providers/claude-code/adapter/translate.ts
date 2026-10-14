// Purpose: Translates one Claude query's SDK messages into AI SDK stream parts with delegate scopes.
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  delegateFinishStep,
  delegateStartStep,
  scopedMetadata,
  type ProviderDelegateCall,
  type ProviderNativeToolOutput,
} from "@openchart/models/provider-protocol";
import { HOST_TOOL_PREFIX, type ToolOutcome } from "./tools";

export type TurnStatus = "completed" | "interrupted" | "error";

export interface TurnTranslatorOptions {
  /** Structured output: only the final `structured_output` is emitted, as one text block. */
  jsonMode: boolean;
  emit(part: LanguageModelV4StreamPart): void;
  /** Consumes the exact outcome of an OpenChart tool this request ran. */
  takeOutcome(toolUseId: string): ToolOutcome | undefined;
  /** The CLI announced the session that persists this conversation. */
  onSession(sessionId: string): void;
  /** The turn reached a terminal status and every part has been emitted. */
  onFinished(status: TurnStatus): void;
}

/** Owning delegate proxy ID (`parent_tool_use_id`), or null for the root assistant. */
type Scope = string | null;
type Json = NonNullable<JSONValue>;
type ContentBlock = SDKAssistantMessage["message"]["content"][number];
type UserBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];
type ToolResultContent = Extract<UserBlock, { type: "tool_result" }>["content"];
type StreamEvent = SDKPartialAssistantMessage["event"];

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function usageOf(result: SDKResultMessage): LanguageModelV4Usage {
  const usage = result.usage as Record<string, unknown> & {
    output_tokens_details?: { thinking_tokens?: number };
  };
  const number = (key: string) =>
    typeof usage[key] === "number" ? (usage[key] as number) : 0;
  const input = number("input_tokens");
  const cacheWrite = number("cache_creation_input_tokens");
  const cacheRead = number("cache_read_input_tokens");
  const output = number("output_tokens");
  const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0;
  return {
    inputTokens: {
      total: input + cacheWrite + cacheRead,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: Math.max(0, output - reasoning),
      reasoning,
    },
  };
}

/** Native tool_result content, with images lifted into the shared media envelope. */
function nativeResult(content: ToolResultContent | undefined): {
  result: unknown;
  media?: true;
} {
  if (typeof content === "string" || content === undefined)
    return { result: content ?? "" };
  const attachments: ProviderNativeToolOutput["attachments"] = [];
  const texts: string[] = [];
  for (const block of content as unknown as Array<Record<string, unknown>>) {
    const source = block.source as
      { type?: string; media_type?: string; data?: string } | undefined;
    if (
      block.type === "image" &&
      source?.type === "base64" &&
      typeof source.media_type === "string" &&
      IMAGE_MIMES.has(source.media_type) &&
      typeof source.data === "string"
    )
      attachments.push({
        mime: source.media_type as ProviderNativeToolOutput["attachments"][number]["mime"],
        url: `data:${source.media_type};base64,${source.data}`,
      });
    else if (block.type === "text" && typeof block.text === "string")
      texts.push(block.text);
    else texts.push(JSON.stringify(block));
  }
  const output = texts.join("\n");
  return attachments.length > 0
    ? { result: { output, attachments }, media: true }
    : { result: output };
}

/**
 * Capability layer for one request. Root text and thinking stream through
 * partial events; subagent text arrives as complete messages scoped by
 * `parent_tool_use_id`. Tool calls come from complete assistant messages, tool
 * results from user messages. A Task/Agent tool call opens a delegate; the SDK
 * emits every child message before that call's tool result, so the child is
 * sealed exactly when its proxy result arrives. OpenChart tool results carry the
 * exact outcome recorded at execution.
 * @example
 * const translator = new TurnTranslator(options);
 * for await (const message of query) translator.handle(message);
 */
export class TurnTranslator {
  private readonly streams = new Map<
    string,
    { id: string; kind: "text" | "reasoning" }
  >();
  private readonly openBlocks = new Map<
    string,
    { kind: "text" | "reasoning"; scope: Scope }
  >();
  private readonly openTools = new Map<
    string,
    { name: string; scope: Scope }
  >();
  private readonly delegates = new Map<
    string,
    { parent: Scope; finished: boolean }
  >();
  private usage = ZERO_USAGE;
  private structured: unknown;
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

  /** Ends the turn when the SDK stops without a terminal result, e.g. after an interrupt. */
  end(status: TurnStatus): void {
    if (this.done) return;
    if (status === "error" && !this.interrupted)
      this.emit({
        type: "error",
        error: new Error("Claude Code stopped without a result"),
      });
    this.finishRoot(this.interrupted ? "interrupted" : status, {
      unified: "error",
      raw: status,
    });
  }

  handle(message: SDKMessage): void {
    if (this.done) return;
    switch (message.type) {
      case "system":
        if (message.subtype === "init")
          this.options.onSession(message.session_id);
        return;
      case "stream_event":
        return this.streamEvent(message.parent_tool_use_id, message.event);
      case "assistant":
        return this.assistant(message);
      case "user":
        return this.user(message);
      case "result":
        return this.result(message);
      default:
        return; // Progress, status, hooks, and rate-limit notices carry no transcript content.
    }
  }

  private scopeOpen(scope: Scope): boolean {
    if (scope === null) return true;
    const delegate = this.delegates.get(scope);
    return delegate !== undefined && !delegate.finished;
  }

  // Root text and thinking stream block by block.

  private streamEvent(scope: Scope, event: StreamEvent): void {
    if (scope !== null) return; // Subagent content arrives as complete messages.
    if (event.type === "content_block_start") {
      const kind =
        event.content_block.type === "text"
          ? "text"
          : event.content_block.type === "thinking"
            ? "reasoning"
            : undefined;
      // Structured output replaces root prose with the final JSON.
      if (kind === "text" && this.options.jsonMode) return;
      if (kind) this.startBlock(`${event.index}`, generateId(), kind, scope);
      return;
    }
    if (event.type === "content_block_delta") {
      const stream = this.streams.get(`${event.index}`);
      if (!stream) return;
      if (event.delta.type === "text_delta")
        this.emit({
          type: "text-delta",
          id: stream.id,
          delta: event.delta.text,
        });
      else if (event.delta.type === "thinking_delta")
        this.emit({
          type: "reasoning-delta",
          id: stream.id,
          delta: event.delta.thinking,
        });
      return;
    }
    if (event.type === "content_block_stop") {
      const stream = this.streams.get(`${event.index}`);
      if (!stream) return;
      this.streams.delete(`${event.index}`);
      this.endBlock(stream.id);
    }
  }

  private startBlock(
    index: string,
    id: string,
    kind: "text" | "reasoning",
    scope: Scope,
  ): void {
    this.streams.set(index, { id, kind });
    this.openBlocks.set(id, { kind, scope });
    this.emit({
      type: kind === "text" ? "text-start" : "reasoning-start",
      id,
      ...scopedMetadata(scope),
    });
  }

  private endBlock(id: string): void {
    const block = this.openBlocks.get(id);
    if (!block) return;
    this.openBlocks.delete(id);
    this.emit({
      type: block.kind === "text" ? "text-end" : "reasoning-end",
      id,
      ...scopedMetadata(block.scope),
    });
  }

  /** A complete block from a subagent: start, delta, end in one go. */
  private wholeBlock(
    kind: "text" | "reasoning",
    text: string,
    scope: Scope,
  ): void {
    if (!text) return;
    const id = generateId();
    const owner = scopedMetadata(scope);
    this.emit({
      type: kind === "text" ? "text-start" : "reasoning-start",
      id,
      ...owner,
    });
    this.emit({
      type: kind === "text" ? "text-delta" : "reasoning-delta",
      id,
      delta: text,
      ...owner,
    });
    this.emit({
      type: kind === "text" ? "text-end" : "reasoning-end",
      id,
      ...owner,
    });
  }

  // Complete messages carry tool calls, subagent content, and tool results.

  private assistant(message: SDKAssistantMessage): void {
    const scope = message.parent_tool_use_id;
    if (!this.scopeOpen(scope)) return;
    for (const block of message.message.content as ContentBlock[]) {
      switch (block.type) {
        case "text":
          if (scope !== null) this.wholeBlock("text", block.text, scope);
          break;
        case "thinking":
          if (scope !== null)
            this.wholeBlock("reasoning", block.thinking, scope);
          break;
        case "tool_use":
          if (this.options.jsonMode && block.name === STRUCTURED_OUTPUT_TOOL)
            break;
          if (SUBAGENT_TOOLS.has(block.name))
            this.startDelegate(block.id, block.name, block.input, scope);
          else this.toolCall(block.id, block.name, block.input, scope);
          break;
        default:
          break;
      }
    }
  }

  private user(message: SDKUserMessage): void {
    const content = message.message.content;
    if (typeof content === "string") return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      if (this.delegates.has(block.tool_use_id))
        this.finishDelegate(
          block.tool_use_id,
          block.is_error ? "error" : "stop",
        );
      this.toolResult(
        block.tool_use_id,
        block.content,
        block.is_error === true,
      );
    }
  }

  // Tools

  private toolCall(
    id: string,
    nativeName: string,
    input: unknown,
    scope: Scope,
  ): void {
    if (this.openTools.has(id)) return;
    const host = nativeName.startsWith(HOST_TOOL_PREFIX);
    const name = host ? nativeName.slice(HOST_TOOL_PREFIX.length) : nativeName;
    this.openTools.set(id, { name, scope });
    const owner = scopedMetadata(
      scope,
      host ? { toolExecution: "provider-mcp" } : undefined,
    );
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

  private toolResult(id: string, content: unknown, isError: boolean): void {
    const open = this.openTools.get(id);
    if (!open) return;
    this.openTools.delete(id);
    const outcome = this.options.takeOutcome(id);
    const native = outcome
      ? undefined
      : nativeResult(content as ToolResultContent | undefined);
    const owner = scopedMetadata(
      open.scope,
      outcome
        ? { toolExecution: "provider-mcp" }
        : native?.media
          ? { toolMedia: true }
          : undefined,
    );
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: open.name,
      result: ((outcome ? outcome.output : native?.result) ?? "") as Json,
      dynamic: true,
      ...(isError || outcome?.isError ? { isError: true } : {}),
      ...owner,
    });
  }

  // Delegates

  private startDelegate(
    id: string,
    nativeName: string,
    input: unknown,
    parent: Scope,
  ): void {
    if (this.delegates.has(id)) return;
    const args = (input ?? {}) as Record<string, unknown>;
    const call: ProviderDelegateCall = {
      description: String(args.description || "Claude subagent"),
      prompt: String(args.prompt ?? ""),
      agent: String(args.subagent_type || "claude"),
    };
    this.delegates.set(id, { parent, finished: false });
    this.openTools.set(id, { name: nativeName, scope: parent });
    const owner = scopedMetadata(parent);
    this.emit({
      type: "tool-input-start",
      id,
      toolName: nativeName,
      providerExecuted: true,
      dynamic: true,
      ...owner,
    });
    this.emit({ type: "tool-input-end", id, ...owner });
    this.emit({
      type: "tool-call",
      toolCallId: id,
      toolName: nativeName,
      input: JSON.stringify(args),
      providerExecuted: true,
      dynamic: true,
      ...scopedMetadata(parent, { openDelegate: call }),
    });
    this.emit(delegateStartStep(id));
  }

  /** Seals a child: nested delegates first, then its open blocks and tools, then the step. */
  private finishDelegate(id: string, reason: "stop" | "error"): void {
    const delegate = this.delegates.get(id);
    if (!delegate || delegate.finished) return;
    for (const [childId, child] of this.delegates)
      if (child.parent === id && !child.finished) {
        this.finishDelegate(childId, reason);
        this.toolResult(childId, { status: "interrupted" }, true);
      }
    this.closeScope(id);
    delegate.finished = true;
    this.emit(delegateFinishStep(id, reason));
  }

  /** Ends every open block and fails every open tool owned by one scope. */
  private closeScope(scope: Scope): void {
    for (const [id, block] of [...this.openBlocks])
      if (block.scope === scope) this.endBlock(id);
    for (const [id, tool] of [...this.openTools])
      if (tool.scope === scope && !this.delegates.has(id))
        this.toolResult(id, { status: "interrupted" }, true);
  }

  // Terminal

  private result(message: SDKResultMessage): void {
    this.usage = usageOf(message);
    if (message.subtype === "success" && !message.is_error) {
      this.structured = message.structured_output;
      const reason: LanguageModelV4FinishReason =
        message.stop_reason === "max_tokens"
          ? { unified: "length", raw: message.stop_reason }
          : { unified: "stop", raw: message.stop_reason ?? "end_turn" };
      this.finishRoot(this.interrupted ? "interrupted" : "completed", reason);
      return;
    }
    if (!this.interrupted)
      this.emit({
        type: "error",
        error: new Error(
          (message.subtype === "success"
            ? message.result
            : message.errors.join("\n")) || "Claude Code request failed",
        ),
      });
    this.finishRoot(this.interrupted ? "interrupted" : "error", {
      unified: message.subtype === "error_max_turns" ? "length" : "error",
      raw: message.subtype,
    });
  }

  private finishRoot(
    status: TurnStatus,
    reason: LanguageModelV4FinishReason,
  ): void {
    if (this.done) return;
    for (const [id, delegate] of [...this.delegates].reverse())
      if (!delegate.finished) {
        this.finishDelegate(id, status === "completed" ? "stop" : "error");
        this.toolResult(id, { status }, status !== "completed");
      }
    this.closeScope(null);
    if (this.options.jsonMode && this.structured !== undefined)
      this.wholeBlock("text", JSON.stringify(this.structured), null);
    this.emit({
      type: "finish",
      finishReason:
        status === "interrupted"
          ? { unified: "stop", raw: "interrupted" }
          : reason,
      usage: this.usage,
    });
    this.done = true;
    this.options.onFinished(status);
  }
}
