// Purpose: Translates one root turn's Codex notifications into AI SDK stream parts with delegate scopes.
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import {
  delegateFinishStep,
  delegateStartStep,
  scopedMetadata,
  type ProtocolMarker,
  type ProviderDelegateCall,
} from "@openchart/models/provider-protocol";
import { mcpToolMedia } from "./media";
import type { AsyncQuestions } from "./async-questions";
import type { Notification, ThreadItem, Turn } from "./protocol";

/** Exact application outcome of an OpenChart tool this request executed. */
export interface ToolOutcome {
  output: unknown;
  isError: boolean;
}

export interface TurnTranslatorOptions {
  rootThreadId: string;
  /** Structured output: only the final assistant message is emitted, as one block. */
  jsonMode: boolean;
  /** Optional request-local bridge for questions carried by assistant messages. */
  asyncQuestions?: AsyncQuestions;
  emit(part: LanguageModelV4StreamPart): void;
  /** Consumes the recorded outcome of an OpenChart tool call this request ran. */
  takeToolOutcome(callId: string): ToolOutcome | undefined;
  /** A native subagent thread now belongs to this request; route its events here. */
  adopt(threadId: string): void;
  /** The root turn reached a terminal status and every part has been emitted. */
  onFinished(status: Turn["status"]): void;
  /** The root turn failed before completing. */
  onError(error: Error): void;
}

/** Owning delegate proxy ID, or null for the root assistant. */
type Scope = string | null;
type Json = NonNullable<JSONValue>;

interface Delegate {
  proxyId: string;
  parent: Scope;
  description: string;
  threadId?: string;
  turnId?: string;
  followup?: true;
  /** Child turn's terminal status once known; the root's completion forces it. */
  outcome?: Turn["status"];
  /** Result text the parent's collaboration item reported for this child. */
  message?: string | null;
  /** The child's own final assistant message. */
  finalText?: string;
  finished: boolean;
}

interface OpenTool {
  name: string;
  scope: Scope;
}

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function finishReason(turn: Turn): LanguageModelV4FinishReason {
  switch (turn.status) {
    case "completed":
      return { unified: "stop", raw: "completed" };
    case "interrupted":
      return { unified: "stop", raw: "interrupted" };
    case "failed": {
      const info = turn.error?.codexErrorInfo;
      return info === "contextWindowExceeded" || info === "usageLimitExceeded"
        ? { unified: "length", raw: String(info) }
        : { unified: "error", raw: turn.error?.message ?? "failed" };
    }
    case "inProgress":
      return { unified: "other", raw: turn.status };
  }
}

function nativeTool(
  item: ThreadItem,
): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "exec", input: { command: item.command, cwd: item.cwd } };
    case "fileChange":
      return { name: "patch", input: { changes: item.changes } };
    case "mcpToolCall":
      return {
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
      };
    case "dynamicToolCall":
      return { name: item.tool, input: item.arguments };
    case "webSearch":
      return { name: "web_search", input: { query: item.query ?? "" } };
    default:
      return undefined;
  }
}

function nativeResult(
  item: ThreadItem,
): { result: unknown; isError: boolean; media?: true } | undefined {
  switch (item.type) {
    case "commandExecution": {
      const output = item.aggregatedOutput ?? "";
      if (item.status !== "completed")
        return {
          result: {
            status: item.status,
            exitCode: item.exitCode ?? null,
            output,
          },
          isError: true,
        };
      return {
        result: item.exitCode ? { exitCode: item.exitCode, output } : output,
        isError: false,
      };
    }
    case "fileChange":
      return {
        result: { status: item.status, changes: item.changes },
        isError: item.status !== "completed",
      };
    case "mcpToolCall": {
      const media = item.result ? mcpToolMedia(item.result) : undefined;
      if (media) return { result: media, isError: false, media: true };
      return {
        result: item.error ?? item.result ?? { status: item.status },
        isError: item.status === "failed" || item.error != null,
      };
    }
    case "webSearch":
      return { result: { query: item.query ?? "" }, isError: false };
    default:
      return undefined;
  }
}

/**
 * Capability layer for one request. Text, reasoning and native tools map one to
 * one. OpenChart tools return the exact outcome the request recorded. Subagents
 * become delegate proxies: child threads bind through spawn receivers, activity
 * items, or `thread/started` parents; child events carry member ownership; the
 * proxy result follows the child's finish so the processor can seal the child
 * first. Parent output is never held back. Root completion finishes any child
 * still open, closes every block, and emits finish.
 * @example
 * const translator = new TurnTranslator(options);
 * translator.handle(parseNotification(method, params)!);
 */
export class TurnTranslator {
  private readonly delegates = new Map<string, Delegate>();
  private readonly threads = new Map<string, string>();
  private readonly waiting = new Map<string, Notification[]>();
  private readonly openText = new Map<string, Scope>();
  private readonly openReasoning = new Map<string, Scope>();
  private readonly streamed = new Set<string>();
  private readonly openTools = new Map<string, OpenTool>();
  private readonly closedTools = new Set<string>();
  private usage = ZERO_USAGE;
  private jsonText = "";
  private done = false;

  constructor(private readonly options: TurnTranslatorOptions) {}

  private emit(part: LanguageModelV4StreamPart): void {
    this.options.emit(part);
  }

  private scopeOf(threadId: string): Scope | undefined {
    if (threadId === this.options.rootThreadId) return null;
    return this.threads.get(threadId) ?? undefined;
  }

  private scopeForTurn(threadId: string, turnId: string): Scope | undefined {
    const scope = this.scopeOf(threadId);
    if (scope === null || scope === undefined) return scope;
    const previous = [...this.delegates.values()].find(
      (delegate) =>
        delegate.threadId === threadId && delegate.turnId === turnId,
    );
    if (previous) return previous.proxyId;
    const delegate = this.delegates.get(scope)!;
    if (delegate.turnId === undefined) {
      delegate.turnId = turnId;
      return scope;
    }
    // Native threads survive follow-ups; each projected delegate is one turn.
    // A nested follow-up may outlive its original parent invocation.
    let parent = delegate.parent;
    while (parent !== null) {
      const ancestor = this.delegates.get(parent)!;
      const current = ancestor.threadId
        ? this.delegates.get(this.threads.get(ancestor.threadId)!)!
        : ancestor;
      if (!current.finished) {
        parent = current.proxyId;
        break;
      }
      parent = ancestor.parent;
    }
    this.threads.delete(threadId);
    const next = this.startDelegate(
      {
        type: "subAgentActivity",
        id: `codex-turn:${threadId}:${turnId}`,
        kind: "started",
        agentThreadId: threadId,
        agentPath: delegate.description,
      },
      parent,
    );
    next.turnId = turnId;
    next.followup = true;
    return next.proxyId;
  }

  /**
   * Opens a host tool in its native turn before execution. Follow-up turns get
   * their own delegate; closed scopes return false without emitting. Threads
   * awaiting delegate binding retain root projection. The caller must decline
   * rejected requests. Request teardown owns cleanup.
   * @example if (!translator.hostToolCalled(thread, turn, id, name, input)) return declined;
   */
  hostToolCalled(
    threadId: string,
    turnId: string,
    callId: string,
    tool: string,
    input: unknown,
  ): boolean {
    if (this.done) return false;
    const scope = this.scopeForTurn(threadId, turnId) ?? null;
    if (scope !== null && this.delegates.get(scope)!.finished) return false;
    this.toolCall(callId, tool, input, scope, "provider-mcp");
    return true;
  }

  /**
   * Records an accepted native question in its turn before the host is asked.
   * Closed scopes return false; the caller must decline without asking the host.
   * Request teardown owns cleanup; answers complete via questionAnswered.
   * @example if (!translator.questionRequested(params)) return declined;
   */
  questionRequested(
    input: {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: unknown;
    },
    toolName = "request_user_input",
  ): boolean {
    if (this.done) return false;
    const scope = this.scopeForTurn(input.threadId, input.turnId) ?? null;
    if (scope !== null && this.delegates.get(scope)!.finished) return false;
    this.toolCall(
      input.itemId,
      toolName,
      { questions: input.questions },
      scope,
    );
    return true;
  }

  /** Completes the native clarification without treating it as an OpenChart host tool. */
  questionAnswered(id: string, output: unknown, isError: boolean): void {
    if (!this.done) this.toolResult(id, output, isError);
  }

  handle(event: Notification): void {
    if (this.done) return;
    switch (event.method) {
      case "thread/started": {
        const { id, parentThreadId } = event.params.thread;
        const parent = parentThreadId
          ? this.scopeOf(parentThreadId)
          : undefined;
        if (parent === undefined || this.threads.has(id)) return;
        // One unbound delegate under this parent: the new thread must be its child.
        const candidates = [...this.delegates.values()].filter(
          (delegate) =>
            delegate.parent === parent && delegate.threadId === undefined,
        );
        if (candidates.length === 1) this.bind(candidates[0]!, id);
        return;
      }
      case "thread/tokenUsage/updated": {
        if (event.params.threadId !== this.options.rootThreadId) return;
        const last = event.params.tokenUsage.last;
        this.usage = {
          inputTokens: {
            total: last.inputTokens,
            noCache: Math.max(0, last.inputTokens - last.cachedInputTokens),
            cacheRead: last.cachedInputTokens,
            cacheWrite: 0,
          },
          outputTokens: {
            total: last.outputTokens,
            text: Math.max(0, last.outputTokens - last.reasoningOutputTokens),
            reasoning: last.reasoningOutputTokens,
          },
        };
        return;
      }
      case "error":
        if (
          event.params.threadId === this.options.rootThreadId &&
          !event.params.willRetry
        )
          this.fail(new Error(event.params.error.message));
        return;
    }
    const turnId =
      event.method === "turn/started" || event.method === "turn/completed"
        ? event.params.turn.id
        : event.params.turnId;
    const scope = this.scopeForTurn(event.params.threadId, turnId);
    if (scope === undefined) {
      // A child thread announced by neither spawn receivers nor activity yet.
      const queue = this.waiting.get(event.params.threadId) ?? [];
      queue.push(event);
      this.waiting.set(event.params.threadId, queue);
      return;
    }
    // A terminal activity can precede the child's own terminal notification.
    if (scope !== null && this.delegates.get(scope)!.finished) return;
    if (
      event.method === "turn/completed" &&
      this.scopeOf(event.params.threadId) === scope
    )
      this.options.asyncQuestions?.finishThread(event.params.threadId);
    switch (event.method) {
      case "turn/started":
        return;
      case "turn/completed":
        if (scope === null) this.finishRoot(event.params.turn);
        else this.childCompleted(scope, event.params.turn);
        return;
      case "item/started":
        return this.itemStarted(event.params.item, scope);
      case "item/completed":
        this.itemCompleted(event.params.item, scope);
        if (
          event.params.item.type === "agentMessage" &&
          event.params.item.questions?.length
        )
          this.options.asyncQuestions?.ask({
            threadId: event.params.threadId,
            turnId: event.params.turnId,
            itemId: event.params.item.id,
            questions: event.params.item.questions,
          });
        return;
      case "item/agentMessage/delta":
        return this.textDelta(event.params.itemId, event.params.delta, scope);
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return this.reasoningDelta(
          event.params.itemId,
          event.params.delta,
          scope,
        );
    }
  }

  private fail(error: Error): void {
    this.done = true;
    this.options.onError(error);
  }

  // Text and reasoning blocks

  private textDelta(id: string, delta: string, scope: Scope): void {
    if (this.options.jsonMode && scope === null) return;
    if (!this.openText.has(id)) {
      this.openText.set(id, scope);
      this.emit({ type: "text-start", id, ...scopedMetadata(scope) });
    }
    this.streamed.add(id);
    this.emit({ type: "text-delta", id, delta, ...scopedMetadata(scope) });
  }

  private textEnd(id: string, text: string, scope: Scope): void {
    if (!this.openText.has(id)) {
      if (!text) return;
      this.openText.set(id, scope);
      this.emit({ type: "text-start", id, ...scopedMetadata(scope) });
    }
    if (!this.streamed.has(id) && text)
      this.emit({
        type: "text-delta",
        id,
        delta: text,
        ...scopedMetadata(scope),
      });
    this.emit({ type: "text-end", id, ...scopedMetadata(scope) });
    this.openText.delete(id);
    this.streamed.delete(id);
  }

  private reasoningDelta(id: string, delta: string, scope: Scope): void {
    if (!this.openReasoning.has(id)) {
      this.openReasoning.set(id, scope);
      this.emit({ type: "reasoning-start", id, ...scopedMetadata(scope) });
    }
    this.streamed.add(id);
    this.emit({
      type: "reasoning-delta",
      id,
      delta,
      ...scopedMetadata(scope),
    });
  }

  private reasoningEnd(id: string, text: string, scope: Scope): void {
    if (!this.openReasoning.has(id)) {
      this.openReasoning.set(id, scope);
      this.emit({ type: "reasoning-start", id, ...scopedMetadata(scope) });
    }
    if (!this.streamed.has(id) && text)
      this.emit({
        type: "reasoning-delta",
        id,
        delta: text,
        ...scopedMetadata(scope),
      });
    this.emit({ type: "reasoning-end", id, ...scopedMetadata(scope) });
    this.openReasoning.delete(id);
    this.streamed.delete(id);
  }

  // Tools

  private toolCall(
    id: string,
    name: string,
    input: unknown,
    scope: Scope,
    execution?: "provider-mcp",
  ): void {
    if (this.openTools.has(id) || this.closedTools.has(id)) return;
    this.openTools.set(id, { name, scope });
    const owner = scopedMetadata(
      scope,
      execution ? { toolExecution: execution } : undefined,
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

  private toolResult(
    id: string,
    result: unknown,
    isError: boolean,
    marker?: ProtocolMarker,
  ): void {
    const open = this.openTools.get(id);
    if (!open) return;
    this.openTools.delete(id);
    this.closedTools.add(id);
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: open.name,
      result: (result ?? {}) as Json,
      dynamic: true,
      ...(isError ? { isError: true } : {}),
      ...scopedMetadata(open.scope, marker),
    });
  }

  private itemStarted(item: ThreadItem, scope: Scope): void {
    switch (item.type) {
      case "reasoning":
        if (!this.openReasoning.has(item.id)) {
          this.openReasoning.set(item.id, scope);
          this.emit({
            type: "reasoning-start",
            id: item.id,
            ...scopedMetadata(scope),
          });
        }
        return;
      case "collabAgentToolCall":
        if (item.tool === "spawnAgent") this.startDelegate(item, scope);
        return;
      case "subAgentActivity":
        if (item.kind === "started") this.startDelegate(item, scope);
        return;
      default: {
        const tool = nativeTool(item);
        if (tool)
          this.toolCall(
            item.id,
            tool.name,
            tool.input,
            scope,
            item.type === "dynamicToolCall" ? "provider-mcp" : undefined,
          );
      }
    }
  }

  private itemCompleted(item: ThreadItem, scope: Scope): void {
    switch (item.type) {
      case "agentMessage":
        if (this.options.jsonMode && scope === null) this.jsonText = item.text;
        else this.textEnd(item.id, item.text, scope);
        if (scope !== null) this.delegates.get(scope)!.finalText = item.text;
        return;
      case "reasoning":
        return this.reasoningEnd(
          item.id,
          [...item.summary, ...item.content].join("\n"),
          scope,
        );
      case "collabAgentToolCall":
        return this.collabCompleted(item, scope);
      case "subAgentActivity": {
        if (item.kind === "started") this.startDelegate(item, scope);
        else if (item.kind === "interacted") {
          // The target may be the parent or a sibling, not a new child. Codex
          // uses this same activity for send_message and followup_task.
          this.toolCall(
            item.id,
            "agent_interaction",
            { target: item.agentPath },
            scope,
          );
          this.toolResult(item.id, { status: "completed" }, false);
        } else {
          const proxyId = this.threads.get(item.agentThreadId);
          const delegate = proxyId ? this.delegates.get(proxyId) : undefined;
          // Activity has no target turn ID and is ambiguous after a follow-up.
          if (delegate && !delegate.followup) {
            delegate.outcome ??= item.kind;
            this.tryFinish(delegate);
          }
        }
        return;
      }
      default: {
        const tool = nativeTool(item);
        if (!tool) return;
        const host = item.type === "dynamicToolCall";
        this.toolCall(
          item.id,
          tool.name,
          tool.input,
          scope,
          host ? "provider-mcp" : undefined,
        );
        if (host) {
          const outcome = this.options.takeToolOutcome(item.id);
          if (outcome)
            this.toolResult(item.id, outcome.output, outcome.isError, {
              toolExecution: "provider-mcp",
            });
          else
            this.toolResult(
              item.id,
              { status: item.status },
              item.success !== true,
            );
        } else {
          const native = nativeResult(item);
          if (native)
            this.toolResult(
              item.id,
              native.result,
              native.isError,
              native.media ? { toolMedia: true } : undefined,
            );
        }
        if (scope !== null) this.tryFinish(this.delegates.get(scope)!);
      }
    }
  }

  // Delegates

  private startDelegate(
    item: Extract<
      ThreadItem,
      { type: "collabAgentToolCall" | "subAgentActivity" }
    >,
    parent: Scope,
  ): Delegate {
    // Activity IDs identify notifications, not subagents. Reuse a child already
    // bound by a collaboration start for this native thread.
    const proxyId =
      item.type === "subAgentActivity"
        ? this.threads.get(item.agentThreadId)
        : undefined;
    const existing = this.delegates.get(proxyId ?? item.id);
    if (existing) return existing;
    const call: ProviderDelegateCall =
      item.type === "collabAgentToolCall"
        ? {
            description: "Codex subagent",
            prompt: item.prompt ?? "",
            agent: item.model?.trim() || "codex",
          }
        : {
            description: item.agentPath || "Codex subagent",
            prompt: "",
            agent: "codex",
          };
    const delegate: Delegate = {
      proxyId: item.id,
      parent,
      description: call.description,
      finished: false,
    };
    this.delegates.set(item.id, delegate);
    this.openTools.set(item.id, { name: "spawn_agent", scope: parent });
    const owner = scopedMetadata(parent);
    this.emit({
      type: "tool-input-start",
      id: item.id,
      toolName: "spawn_agent",
      providerExecuted: true,
      dynamic: true,
      ...owner,
    });
    this.emit({ type: "tool-input-end", id: item.id, ...owner });
    this.emit({
      type: "tool-call",
      toolCallId: item.id,
      toolName: "spawn_agent",
      input: JSON.stringify({
        description: call.description,
        prompt: call.prompt,
        subagent_type: call.agent,
      }),
      providerExecuted: true,
      dynamic: true,
      ...scopedMetadata(parent, { openDelegate: call }),
    });
    this.emit(delegateStartStep(item.id));
    if (item.type === "subAgentActivity")
      this.bind(delegate, item.agentThreadId);
    return delegate;
  }

  private bind(delegate: Delegate, threadId: string): void {
    if (delegate.threadId !== undefined || this.threads.has(threadId)) return;
    delegate.threadId = threadId;
    this.threads.set(threadId, delegate.proxyId);
    this.options.adopt(threadId);
    const queued = this.waiting.get(threadId) ?? [];
    this.waiting.delete(threadId);
    for (const event of queued) this.handle(event);
  }

  private collabCompleted(
    item: Extract<ThreadItem, { type: "collabAgentToolCall" }>,
    scope: Scope,
  ): void {
    if (item.tool === "spawnAgent") {
      const delegate = this.startDelegate(item, scope);
      const receiver = item.receiverThreadIds[0];
      if (item.status === "completed" && receiver)
        this.bind(delegate, receiver);
      else if (item.status !== "inProgress")
        delegate.outcome ??=
          item.status === "interrupted" ? "interrupted" : "failed";
    }
    for (const threadId of item.receiverThreadIds) {
      const proxyId = this.threads.get(threadId);
      const delegate = proxyId ? this.delegates.get(proxyId) : undefined;
      if (!delegate) continue;
      const state = item.agentsStates[threadId];
      if (state?.message !== undefined && !delegate.followup)
        delegate.message = state.message;
      this.tryFinish(delegate);
    }
  }

  private childCompleted(proxyId: string, turn: Turn): void {
    const delegate = this.delegates.get(proxyId)!;
    delegate.outcome = turn.status === "inProgress" ? "completed" : turn.status;
    this.tryFinish(delegate);
  }

  /** Ends every open block and fails every open tool owned by one scope. */
  private closeScope(scope: Scope): void {
    for (const [id, owner] of [...this.openText])
      if (owner === scope) this.textEnd(id, "", scope);
    for (const [id, owner] of [...this.openReasoning])
      if (owner === scope) this.reasoningEnd(id, "", scope);
    for (const [id, tool] of [...this.openTools])
      if (tool.scope === scope && !this.delegates.has(id))
        this.toolResult(id, { status: "interrupted" }, true);
  }

  private tryFinish(delegate: Delegate): void {
    if (delegate.finished || delegate.outcome === undefined) return;
    for (const other of this.delegates.values())
      if (other.parent === delegate.proxyId && !other.finished) return;
    if (
      delegate.threadId &&
      this.scopeOf(delegate.threadId) === delegate.proxyId
    )
      this.options.asyncQuestions?.finishThread(delegate.threadId);
    this.closeScope(delegate.proxyId);
    delegate.finished = true;
    // Retain the binding for late parent activity items until this root turn ends.
    const completed = delegate.outcome === "completed";
    this.emit(
      delegateFinishStep(
        delegate.proxyId,
        completed || delegate.outcome === "interrupted" ? "stop" : "error",
      ),
    );
    this.toolResult(
      delegate.proxyId,
      delegate.message ?? delegate.finalText ?? { status: delegate.outcome },
      !completed,
    );
    if (delegate.parent !== null)
      this.tryFinish(this.delegates.get(delegate.parent)!);
  }

  private finishRoot(turn: Turn): void {
    const forced: Turn["status"] =
      turn.status === "completed"
        ? "completed"
        : turn.status === "interrupted"
          ? "interrupted"
          : "failed";
    for (const delegate of this.delegates.values()) delegate.outcome ??= forced;
    // Leaves finish first; each finish retries its parent, so a few passes settle nesting.
    let unfinished = [...this.delegates.values()].filter(
      (delegate) => !delegate.finished,
    );
    while (unfinished.length > 0) {
      for (const delegate of unfinished) this.tryFinish(delegate);
      const remaining = unfinished.filter((delegate) => !delegate.finished);
      if (remaining.length === unfinished.length) break;
      unfinished = remaining;
    }
    this.closeScope(null);
    if (this.options.jsonMode && this.jsonText)
      this.textEnd("final", this.jsonText, null);
    this.emit({
      type: "finish",
      finishReason: finishReason(turn),
      usage: this.usage,
    });
    this.done = true;
    this.options.onFinished(turn.status);
  }
}
