// Purpose: Translates one Grok ACP turn, its subagent sessions, and host tool calls into AI SDK stream parts.
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import {
  delegateFinishStep,
  delegateStartStep,
  scopedMetadata,
  type ProviderDelegateCall,
} from "@openchart/models/provider-protocol";
import type {
  PromptResult,
  SessionUpdate,
  SubagentNotice,
  TurnUsage,
} from "./events";
import { HOST_TOOL_PREFIX } from "./host-tools";

export type TurnStatus = "completed" | "interrupted" | "error";

/** Delegate call ID that owns an event; null is the root session. */
type Scope = string | null;
type Json = NonNullable<JSONValue>;

export interface TurnTranslatorOptions {
  /** Structured output: only the final structured value is emitted, as one text block. */
  jsonMode: boolean;
  emit(part: LanguageModelV4StreamPart): void;
  /** The turn reached a terminal status and every part has been emitted. */
  onFinished(status: TurnStatus): void;
}

interface OpenTool {
  name: string;
  scope: Scope;
  /** Plumbing never reaches the stream: tool discovery and OpenChart's MCP calls. */
  hidden: boolean;
}

interface Delegate {
  parent: Scope;
  description: string;
  /** The child session, once `subagent_spawned` names it. */
  session?: string;
  finished: boolean;
}

const HOST = { toolExecution: "provider-mcp" } as const;

function usageOf(usage: TurnUsage | undefined): LanguageModelV4Usage {
  const input = usage?.inputTokens ?? 0;
  const cacheRead = Math.min(input, usage?.cachedReadTokens ?? 0);
  const output = usage?.outputTokens ?? 0;
  const reasoning = Math.min(output, usage?.reasoningTokens ?? 0);
  return {
    inputTokens: {
      total: input,
      noCache: input - cacheRead,
      cacheRead,
      cacheWrite: usage?.cacheCreationTokens,
    },
    outputTokens: { total: output, text: output - reasoning, reasoning },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Grok's tool identity: its `x.ai/tool` name, else the backend variant, else the title. */
function toolName(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
) {
  const native = update._meta?.["x.ai/tool"]?.name;
  if (native) return native;
  const variant = record(update.rawInput).variant;
  if (variant === "XSearch") return "x_search";
  if (variant === "WebSearch") return "web_search";
  return update.title || "tool";
}

/** What ACP clients display for a finished tool: its text content, else the raw output. */
function toolResult(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): Json {
  const text = (update.content ?? [])
    .map((entry) => entry.content?.text ?? "")
    .join("")
    .trim();
  if (text) return text;
  return (update.rawOutput ?? "") as Json;
}

/**
 * Capability layer for one turn. Root text and reasoning stream from the root
 * session's chunks; every native tool becomes a provider-executed call and
 * result. A foreground `spawn_subagent` call opens a delegate: Grok streams the
 * child as its own session, which `subagent_spawned` binds to that call, and
 * `subagent_finished` seals it before the parent's proxy result. Background
 * subagents stay ordinary tool calls whose sessions are not shown. OpenChart
 * tool calls arrive from the host server with their exact outcomes; Grok's
 * `search_tool` and OpenChart `use_tool` steps are plumbing and never shown.
 * Usage is the turn total Grok reports, subagents included.
 * @example
 * const translator = new TurnTranslator(options);
 * translator.bindRoot(sessionId);
 * translator.update(sessionId, update);
 */
export class TurnTranslator {
  private root: string | undefined;
  private readonly sessions = new Map<string, Scope>();
  private readonly blocks = new Map<
    Scope,
    { id: string; type: "text" | "reasoning" }
  >();
  private readonly tools = new Map<string, OpenTool>();
  private readonly delegates = new Map<string, Delegate>();
  private readonly hostCalls = new Map<
    string,
    { name: string; scope: Scope }
  >();
  /** Scopes of hidden OpenChart `use_tool` calls, per tool, awaiting their MCP request. */
  private readonly hostScopes = new Map<string, Scope[]>();
  private interrupted = false;
  private done = false;

  constructor(private readonly options: TurnTranslatorOptions) {}

  private emit(part: LanguageModelV4StreamPart): void {
    this.options.emit(part);
  }

  /** Names the session this turn prompts; its updates belong to the root. */
  bindRoot(sessionId: string): void {
    this.root = sessionId;
    this.sessions.set(sessionId, null);
  }

  /** The caller asked Grok to stop; the terminal result becomes an interruption. */
  markInterrupted(): void {
    this.interrupted = true;
  }

  /** One `session/update` from the root or a bound child session. */
  update(sessionId: string, update: SessionUpdate): void {
    if (this.done || !this.sessions.has(sessionId)) return;
    const scope = this.sessions.get(sessionId)!;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (scope === null && this.options.jsonMode) return;
        return this.chunk(scope, "text", update.content.text);
      case "agent_thought_chunk":
        return this.chunk(scope, "reasoning", update.content.text);
      case "tool_call":
        return this.toolCall(scope, update);
      case "tool_call_update":
        return this.toolUpdate(update);
    }
  }

  /** Subagent lifecycle from `_x.ai/session_notification`. */
  subagent(notice: SubagentNotice): void {
    if (this.done) return;
    if (notice.sessionUpdate === "subagent_spawned") {
      if (!this.sessions.has(notice.parent_session_id)) return;
      const parent = this.sessions.get(notice.parent_session_id)!;
      const waiting = [...this.delegates].filter(
        ([, delegate]) =>
          delegate.parent === parent && !delegate.session && !delegate.finished,
      );
      // Spawn notices name no call; the description identifies concurrent spawns.
      const [id, delegate] =
        waiting.find(
          ([, candidate]) => candidate.description === notice.description,
        ) ??
        waiting[0] ??
        [];
      if (!id || !delegate) return;
      delegate.session = notice.child_session_id;
      this.sessions.set(notice.child_session_id, id);
      return;
    }
    const id = this.sessions.get(notice.child_session_id);
    if (id)
      this.finishDelegate(id, notice.status === "completed" ? "stop" : "error");
  }

  /** Ends the turn when the agent exits or a request fails without a result. */
  fail(error: unknown): void {
    if (this.done) return;
    if (!this.interrupted) this.emit({ type: "error", error });
    this.finish(this.interrupted ? "interrupted" : "error", undefined, {
      unified: "error",
      raw: "failed",
    });
  }

  /** The `session/prompt` result. */
  result(result: PromptResult): void {
    if (this.done) return;
    const meta = result._meta;
    if (result.stopReason === "cancelled" || this.interrupted) {
      this.finish("interrupted", meta?.usage, {
        unified: "stop",
        raw: "interrupted",
      });
      return;
    }
    if (this.options.jsonMode) {
      if (meta?.structuredOutput === undefined) {
        this.emit({
          type: "error",
          error: new Error(
            `Grok returned no structured output${
              meta?.structuredOutputError
                ? `: ${JSON.stringify(meta.structuredOutputError)}`
                : ""
            }`,
          ),
        });
        this.finish("error", meta?.usage, {
          unified: "error",
          raw: "structured_output",
        });
        return;
      }
      this.wholeText(JSON.stringify(meta.structuredOutput));
    }
    const reason: LanguageModelV4FinishReason["unified"] =
      result.stopReason === "end_turn"
        ? "stop"
        : result.stopReason === "max_tokens" ||
            result.stopReason === "max_turn_requests"
          ? "length"
          : result.stopReason === "refusal"
            ? "content-filter"
            : "other";
    this.finish("completed", meta?.usage, {
      unified: reason,
      raw: result.stopReason,
    });
  }

  // OpenChart tools, reported by the host server.

  hostToolStarted(id: string, name: string, input: unknown): void {
    if (this.done) return;
    const scope = this.hostScopes.get(name)?.shift() ?? null;
    this.hostCalls.set(id, { name, scope });
    this.startTool(id, name, input, scope, true);
  }

  hostToolFinished(
    id: string,
    name: string,
    output: unknown,
    isError: boolean,
  ): void {
    const call = this.hostCalls.get(id);
    if (this.done || !call) return;
    this.hostCalls.delete(id);
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      result: (output ?? "") as Json,
      dynamic: true,
      ...(isError ? { isError: true } : {}),
      ...scopedMetadata(call.scope, HOST),
    });
  }

  // Content

  private chunk(scope: Scope, type: "text" | "reasoning", delta?: string) {
    if (!delta) return;
    let block = this.blocks.get(scope);
    if (block?.type !== type) {
      this.endBlock(scope);
      block = { id: generateId(), type };
      this.blocks.set(scope, block);
      this.emit({
        type: `${type}-start`,
        id: block.id,
        ...scopedMetadata(scope),
      });
    }
    this.emit({
      type: `${type}-delta`,
      id: block.id,
      delta,
      ...scopedMetadata(scope),
    });
  }

  private endBlock(scope: Scope): void {
    const block = this.blocks.get(scope);
    if (!block) return;
    this.blocks.delete(scope);
    this.emit({
      type: `${block.type}-end`,
      id: block.id,
      ...scopedMetadata(scope),
    });
  }

  private wholeText(text: string): void {
    const id = generateId();
    this.emit({ type: "text-start", id });
    this.emit({ type: "text-delta", id, delta: text });
    this.emit({ type: "text-end", id });
  }

  // Native tools

  private toolCall(
    scope: Scope,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
  ): void {
    const id = update.toolCallId;
    if (this.tools.has(id) || this.delegates.has(id)) return;
    this.endBlock(scope);
    const name = toolName(update);
    const input = record(update.rawInput);
    if (name === "search_tool") {
      this.tools.set(id, { name, scope, hidden: true });
      return;
    }
    if (
      name === "use_tool" &&
      typeof input.tool_name === "string" &&
      input.tool_name.startsWith(HOST_TOOL_PREFIX)
    ) {
      const host = input.tool_name.slice(HOST_TOOL_PREFIX.length);
      this.hostScopes.set(host, [...(this.hostScopes.get(host) ?? []), scope]);
      this.tools.set(id, { name, scope, hidden: true });
      return;
    }
    if (name === "spawn_subagent" && input.background !== true) {
      this.startDelegate(id, name, input, scope);
      return;
    }
    this.tools.set(id, { name, scope, hidden: false });
    this.startTool(id, name, input, scope, false);
  }

  private toolUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
  ): void {
    const open = this.tools.get(update.toolCallId);
    if (!open) return;
    if (update.status !== "completed" && update.status !== "failed") return;
    this.tools.delete(update.toolCallId);
    if (open.hidden) return;
    const failed = update.status === "failed";
    const delegate = this.delegates.get(update.toolCallId);
    // The parent's result completes the proxy only after the child is sealed.
    if (delegate && !delegate.finished)
      this.finishDelegate(update.toolCallId, failed ? "error" : "stop");
    const output = record(update.rawOutput);
    this.emit({
      type: "tool-result",
      toolCallId: update.toolCallId,
      toolName: open.name,
      result:
        delegate && typeof output.output === "string"
          ? output.output
          : toolResult(update),
      dynamic: true,
      ...(failed ? { isError: true } : {}),
      ...scopedMetadata(open.scope),
    });
  }

  private startTool(
    id: string,
    name: string,
    input: unknown,
    scope: Scope,
    host: boolean,
  ): void {
    const owner = scopedMetadata(scope, host ? HOST : undefined);
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

  // Delegates

  private startDelegate(
    id: string,
    name: string,
    input: Record<string, unknown>,
    parent: Scope,
  ): void {
    const call: ProviderDelegateCall = {
      description: String(input.description || "Grok subagent"),
      prompt: String(input.prompt ?? ""),
      agent: String(input.subagent_type || "general-purpose"),
    };
    this.delegates.set(id, {
      parent,
      description: call.description,
      finished: false,
    });
    this.tools.set(id, { name, scope: parent, hidden: false });
    const owner = scopedMetadata(parent);
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
      input: JSON.stringify(input),
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
        this.closeTool(childId, { status: "interrupted" });
      }
    this.closeScope(id);
    delegate.finished = true;
    this.emit(delegateFinishStep(id, reason));
  }

  /** Ends every open block and fails every open tool owned by one scope. */
  private closeScope(scope: Scope): void {
    this.endBlock(scope);
    for (const [id, tool] of [...this.tools])
      if (tool.scope === scope && !this.delegates.has(id))
        this.closeTool(id, { status: "interrupted" });
    for (const [id, call] of [...this.hostCalls])
      if (call.scope === scope)
        this.hostToolFinished(id, call.name, { status: "interrupted" }, true);
  }

  /** Fails one open native tool or delegate proxy without a native result. */
  private closeTool(id: string, result: Json): void {
    const open = this.tools.get(id);
    if (!open) return;
    this.tools.delete(id);
    if (open.hidden) return;
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: open.name,
      result,
      dynamic: true,
      isError: true,
      ...scopedMetadata(open.scope),
    });
  }

  // Terminal

  private finish(
    status: TurnStatus,
    usage: TurnUsage | undefined,
    reason: LanguageModelV4FinishReason,
  ): void {
    if (this.done) return;
    for (const [id, delegate] of [...this.delegates].reverse())
      if (!delegate.finished) {
        this.finishDelegate(id, status === "completed" ? "stop" : "error");
        this.closeTool(id, { status });
      }
    this.closeScope(null);
    this.emit({
      type: "finish",
      finishReason: reason,
      usage: usageOf(usage),
    });
    this.done = true;
    this.options.onFinished(status);
  }
}
