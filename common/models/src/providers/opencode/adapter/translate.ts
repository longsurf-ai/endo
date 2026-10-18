// Purpose: Translates scoped OpenCode native updates and exact host outcomes into Endo's stream protocol.
import type {
  JSONValue,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import {
  delegateFinishStep,
  delegateStartStep,
  scopedMetadata,
} from "@openchart/models/provider-protocol";
import { z } from "zod";

type Scope = string | null;
const Content = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});
const Tool = z.looseObject({
  sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
  toolCallId: z.string(),
  name: z.string().optional(),
  title: z.string().nullish(),
  status: z.string().nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  content: z.array(z.unknown()).nullish(),
});
export const PromptResult = z.looseObject({
  stopReason: z.string(),
  usage: z
    .looseObject({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      thoughtTokens: z.number().nonnegative().optional(),
      cachedReadTokens: z.number().nonnegative().optional(),
      cachedWriteTokens: z.number().nonnegative().optional(),
    })
    .optional(),
});
const Child = z.looseObject({
  childSessionId: z.string(),
  parentSessionId: z.string(),
  title: z.string().optional(),
  type: z.enum(["update", "status"]),
  update: z.unknown().optional(),
  status: z.string().optional(),
});
interface NativeTool {
  name: string;
  input: unknown;
  started: boolean;
  scope: Scope;
}
interface Delegate {
  id: string;
  parent: Scope;
  finished: boolean;
}

/**
 * Owns one turn's scoped blocks and tool outcomes. Child sessions get explicit
 * delegate lifecycles; native parent proxy results never substitute child content.
 * Host session metadata routes exact opaque outcomes, independently of native
 * codemode proxy steps. Finish closes every pending tool/block exactly once.
 * @example const turn = new TurnTranslator(part => controller.enqueue(part));
 */
export class TurnTranslator {
  private root?: string;
  private blocks = new Map<Scope, { id: string; type: "text" | "reasoning" }>();
  private tools = new Map<string, NativeTool>();
  private host = new Map<string, { name: string; scope: Scope }>();
  private children = new Map<string, Delegate>();
  private done = false;
  constructor(
    private readonly emit: (part: LanguageModelV4StreamPart) => void,
    private readonly jsonMode = false,
  ) {}
  bindRoot(id: string): void {
    this.root = id;
  }

  update(value: unknown, scope: Scope = null): void {
    if (this.done) return;
    const base = z.looseObject({ sessionUpdate: z.string() }).parse(value);
    if (
      base.sessionUpdate === "agent_message_chunk" ||
      base.sessionUpdate === "agent_thought_chunk"
    ) {
      const { content } = z.looseObject({ content: Content }).parse(value);
      if (content.type !== "text" || !content.text) return;
      const type =
        base.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning";
      if (this.jsonMode && type === "text" && scope === null) return;
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
        delta: content.text,
        ...scopedMetadata(scope),
      });
      return;
    }
    if (
      base.sessionUpdate !== "tool_call" &&
      base.sessionUpdate !== "tool_call_update"
    )
      return;
    const update = Tool.parse(value);
    const id = scope ? `${scope}:${update.toolCallId}` : update.toolCallId;
    let tool = this.tools.get(id);
    if (!tool) {
      tool = {
        name: update.name ?? update.title ?? "native_tool",
        input: update.rawInput ?? {},
        started: false,
        scope,
      };
      this.tools.set(id, tool);
      this.endBlock(scope);
      this.emit({
        type: "tool-input-start",
        id,
        toolName: tool.name,
        providerExecuted: true,
        dynamic: true,
        ...scopedMetadata(scope),
      });
    }
    if (update.rawInput !== undefined) tool.input = update.rawInput;
    if (update.status !== "completed" && update.status !== "failed") return;
    this.startNative(id, tool);
    this.tools.delete(id);
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: tool.name,
      result: {
        content: update.content ?? [],
        output: update.rawOutput ?? null,
      } as NonNullable<JSONValue>,
      dynamic: true,
      ...(update.status === "failed" ? { isError: true } : {}),
      ...scopedMetadata(scope),
    });
  }

  /** Uses the pinned child-update extension, never child proxy output. */
  child(value: unknown): void {
    if (this.done) return;
    const notice = Child.parse(value);
    let child = this.children.get(notice.childSessionId);
    if (!child) {
      const parent =
        notice.parentSessionId === this.root
          ? null
          : this.children.get(notice.parentSessionId)?.id;
      if (parent === undefined)
        throw new Error("OpenCode reported a child before its parent");
      const id = `opencode-child:${notice.childSessionId}`;
      child = { id, parent, finished: false };
      this.children.set(notice.childSessionId, child);
      const description = notice.title ?? "OpenCode child session";
      const owner = scopedMetadata(parent);
      this.emit({
        type: "tool-input-start",
        id,
        toolName: "Agent",
        providerExecuted: true,
        dynamic: true,
        ...owner,
      });
      this.emit({ type: "tool-input-end", id, ...owner });
      this.emit({
        type: "tool-call",
        toolCallId: id,
        toolName: "Agent",
        input: JSON.stringify({ sessionId: notice.childSessionId }),
        providerExecuted: true,
        dynamic: true,
        ...scopedMetadata(parent, {
          openDelegate: { description, prompt: "", agent: "OpenCode" },
        }),
      });
      this.emit(delegateStartStep(id));
    }
    if (child.finished) return;
    if (notice.type === "update") this.update(notice.update, child.id);
    else if (
      ["completed", "failed", "interrupted"].includes(notice.status ?? "")
    )
      this.finishChild(child, notice.status === "completed");
  }

  hostStarted(
    id: string,
    name: string,
    input: unknown,
    sessionID?: string,
  ): void {
    if (this.done) return;
    const scope =
      !sessionID || sessionID === this.root
        ? null
        : this.children.get(sessionID)?.id;
    if (scope === undefined)
      throw new Error("OpenCode host tool has an unknown owning session");
    this.endBlock(scope);
    this.host.set(id, { name, scope });
    const metadata = scopedMetadata(scope, { toolExecution: "provider-mcp" });
    this.emit({
      type: "tool-input-start",
      id,
      toolName: name,
      providerExecuted: true,
      dynamic: true,
      ...metadata,
    });
    this.emit({ type: "tool-input-end", id, ...metadata });
    this.emit({
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(input),
      providerExecuted: true,
      dynamic: true,
      ...metadata,
    });
  }
  hostFinished(
    id: string,
    name: string,
    result: unknown,
    isError: boolean,
  ): void {
    const call = this.host.get(id);
    if (this.done || !call) return;
    this.host.delete(id);
    this.emit({
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      result: result as NonNullable<JSONValue>,
      dynamic: true,
      ...(isError ? { isError: true } : {}),
      ...scopedMetadata(call.scope, { toolExecution: "provider-mcp" }),
    });
  }

  finish(value: unknown, structured?: unknown): void {
    if (this.done) return;
    const result = PromptResult.parse(value);
    this.endBlock(null);
    if (this.jsonMode && result.stopReason !== "cancelled") {
      if (structured === undefined)
        throw new Error("OpenCode did not submit valid structured output");
      const id = generateId();
      this.emit({ type: "text-start", id });
      this.emit({ type: "text-delta", id, delta: JSON.stringify(structured) });
      this.emit({ type: "text-end", id });
    }
    for (const child of this.children.values())
      if (!child.finished) this.finishChild(child, false);
    this.closeScope(null);
    const raw = result.usage;
    const usage: LanguageModelV4Usage = {
      inputTokens: {
        total: raw
          ? raw.inputTokens +
            (raw.cachedReadTokens ?? 0) +
            (raw.cachedWriteTokens ?? 0)
          : undefined,
        noCache: raw?.inputTokens,
        cacheRead: raw?.cachedReadTokens,
        cacheWrite: raw?.cachedWriteTokens,
      },
      outputTokens: {
        total: raw ? raw.outputTokens + (raw.thoughtTokens ?? 0) : undefined,
        text: raw?.outputTokens,
        reasoning: raw?.thoughtTokens,
      },
    };
    this.emit({
      type: "finish",
      finishReason: {
        unified:
          result.stopReason === "end_turn" || result.stopReason === "cancelled"
            ? "stop"
            : result.stopReason === "max_tokens"
              ? "length"
              : "other",
        raw: result.stopReason,
      },
      usage,
    });
    this.done = true;
  }
  fail(error: unknown): void {
    if (this.done) return;
    for (const child of this.children.values())
      if (!child.finished) this.finishChild(child, false);
    this.closeScope(null);
    this.emit({ type: "error", error });
    this.done = true;
  }
  private endBlock(scope: Scope): void {
    const block = this.blocks.get(scope);
    if (!block) return;
    this.emit({
      type: `${block.type}-end`,
      id: block.id,
      ...scopedMetadata(scope),
    });
    this.blocks.delete(scope);
  }
  private startNative(id: string, tool: NativeTool): void {
    if (tool.started) return;
    tool.started = true;
    const owner = scopedMetadata(tool.scope);
    this.emit({ type: "tool-input-end", id, ...owner });
    this.emit({
      type: "tool-call",
      toolCallId: id,
      toolName: tool.name,
      input: JSON.stringify(tool.input),
      providerExecuted: true,
      dynamic: true,
      ...owner,
    });
  }
  private closeScope(scope: Scope): void {
    this.endBlock(scope);
    for (const [id, tool] of this.tools)
      if (tool.scope === scope) {
        this.startNative(id, tool);
        this.tools.delete(id);
        this.emit({
          type: "tool-result",
          toolCallId: id,
          toolName: tool.name,
          result: { status: "interrupted" },
          dynamic: true,
          isError: true,
          ...scopedMetadata(scope),
        });
      }
    for (const [id, call] of this.host)
      if (call.scope === scope)
        this.hostFinished(id, call.name, { status: "interrupted" }, true);
  }
  private finishChild(child: Delegate, success: boolean): void {
    for (const nested of this.children.values())
      if (nested.parent === child.id && !nested.finished)
        this.finishChild(nested, false);
    this.closeScope(child.id);
    child.finished = true;
    this.emit(delegateFinishStep(child.id, success ? "stop" : "error"));
    this.emit({
      type: "tool-result",
      toolCallId: child.id,
      toolName: "Agent",
      result: { status: success ? "completed" : "interrupted" },
      dynamic: true,
      ...(success ? {} : { isError: true }),
      ...scopedMetadata(child.parent),
    });
  }
}
