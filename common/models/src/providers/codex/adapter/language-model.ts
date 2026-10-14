// Purpose: Implements the AI SDK language model as one Codex thread per request over the shared process.
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateId, parseProviderOptions } from "@ai-sdk/provider-utils";
import { z, type ZodType } from "zod";
import type { Continuation } from "@openchart/models/providers/continuation";
import { collectGeneration } from "@openchart/models/providers/generate";
import { convertPrompt, type ConvertedPrompt } from "./history";
import {
  EmptyResponse,
  ThreadStartResponse,
  TurnStartResponse,
  parseNotification,
  type DynamicToolOutput,
  type DynamicToolSpec,
  type ServerRequest,
  type ThreadStartParams,
  type TurnStartParams,
} from "./protocol";
import type { CodexRpc } from "./rpc";
import {
  declineServerRequest,
  type ThreadContext,
  type ThreadRouter,
} from "./threads";
import { TurnTranslator, type ToolOutcome } from "./translate";
import { createAsyncQuestions } from "./async-questions";

export const CODEX_PROVIDER = "codex-app-server";

/** Shape-only view of an OpenChart tool; the binding supplies the real definitions. */
export interface CodexHostTool {
  description: string;
  inputSchema: ZodType;
  /** Returns the exact application outcome; the model sees toModelOutput() of it. */
  execute(
    input: unknown,
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<unknown>;
  toModelOutput(output: unknown): unknown;
}

/** Host policy for native approvals; undefined selects the fail-closed default. */
export type CodexRequestPolicy = (
  request: ServerRequest,
  options: { signal: AbortSignal },
) => Promise<unknown | undefined>;

const ProviderOptions = z.object({
  cwd: z.string().optional(),
  effort: z.string().optional(),
  summary: z.string().optional(),
  approvalPolicy: z.enum(["on-request", "never"]).optional(),
  approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
  tools: z
    .custom<Record<string, CodexHostTool>>(
      (value) => typeof value === "object" && value !== null,
    )
    .optional(),
  requests: z
    .custom<CodexRequestPolicy>((value) => typeof value === "function")
    .optional(),
});

/** Request-scoped options under the `codex-app-server` provider namespace. */
export type CodexProviderOptions = z.infer<typeof ProviderOptions>;

export interface CodexLanguageModelOptions {
  modelId: string;
  rpc: CodexRpc;
  router: ThreadRouter;
  continuation: Continuation;
  /** Native config overrides applied to every thread this model starts. */
  config?: Record<string, unknown>;
}

const INTERRUPT_GRACE_MS = 5_000;

/**
 * Each call owns one native turn. A remembered thread receives only the new
 * user message; otherwise a fresh thread is started, prior history is injected
 * as Responses items, and the final user message starts the turn. OpenChart
 * tools run in-process through Codex dynamic tools; approvals go to the host
 * policy. Cancellation interrupts the turn and the stream closes on its
 * terminal notification. Process exit fails the stream.
 * @example const model = provider.languageModel("gpt-5.6-luna");
 */
export class CodexLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = CODEX_PROVIDER;
  readonly supportedUrls = {};
  readonly modelId: string;

  constructor(private readonly options: CodexLanguageModelOptions) {
    this.modelId = options.modelId;
  }

  private async startThread(
    prompt: ConvertedPrompt,
    request: CodexProviderOptions,
    dynamicTools: DynamicToolSpec[],
  ): Promise<string> {
    const params: ThreadStartParams = {
      model: this.modelId,
      cwd: request.cwd,
      approvalPolicy: request.approvalPolicy ?? "on-request",
      approvalsReviewer: request.approvalsReviewer ?? "user",
      sandbox: request.sandbox ?? "read-only",
      developerInstructions: prompt.developerInstructions,
      config: this.options.config,
      ephemeral: false,
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    };
    const { thread } = await this.options.rpc.request(
      "thread/start",
      params,
      ThreadStartResponse,
    );
    if (prompt.history.length > 0)
      await this.options.rpc.request(
        "thread/inject_items",
        { threadId: thread.id, items: prompt.history },
        EmptyResponse,
      );
    return thread.id;
  }

  private async callTool(
    params: Extract<ServerRequest, { method: "item/tool/call" }>["params"],
    tools: Record<string, CodexHostTool>,
    translator: TurnTranslator,
    outcomes: Map<string, ToolOutcome>,
    abortSignal: AbortSignal | undefined,
  ): Promise<DynamicToolOutput> {
    if (
      !translator.hostToolCalled(
        params.threadId,
        params.turnId,
        params.callId,
        params.tool,
        params.arguments,
      )
    )
      return { contentItems: [], success: false };
    const tool = tools[params.tool];
    const text = (value: unknown) =>
      typeof value === "string" ? value : JSON.stringify(value ?? null);
    if (!tool) {
      const message = `Unknown tool ${params.tool}`;
      outcomes.set(params.callId, { output: message, isError: true });
      return {
        contentItems: [{ type: "inputText", text: message }],
        success: false,
      };
    }
    try {
      const output = await tool.execute(params.arguments, {
        toolCallId: params.callId,
        abortSignal,
      });
      outcomes.set(params.callId, { output, isError: false });
      return {
        contentItems: [
          { type: "inputText", text: text(tool.toModelOutput(output)) },
        ],
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.set(params.callId, { output: message, isError: true });
      return {
        contentItems: [{ type: "inputText", text: message }],
        success: false,
      };
    }
  }

  async doStream(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>> {
    call.abortSignal?.throwIfAborted();
    const { rpc, router, continuation } = this.options;
    const request =
      (await parseProviderOptions({
        provider: CODEX_PROVIDER,
        providerOptions: call.providerOptions,
        schema: ProviderOptions,
      })) ?? {};
    const tools = request.tools ?? {};
    const dynamicTools: DynamicToolSpec[] = Object.entries(tools).map(
      ([name, tool]) => ({
        type: "function",
        name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.inputSchema),
      }),
    );
    const prompt = convertPrompt(call.prompt);
    // Changing policy starts a fresh thread so prior grants cannot survive a downgrade.
    const permissions = {
      approvalPolicy: request.approvalPolicy ?? "on-request",
      approvalsReviewer: request.approvalsReviewer ?? "user",
      sandbox: request.sandbox ?? "read-only",
    } as const;
    const configuration = JSON.stringify({ dynamicTools, permissions });
    const threadId =
      continuation.take(call.prompt, configuration) ??
      (await this.startThread(prompt, request, dynamicTools));

    let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (next) => {
        controller = next;
      },
      cancel: () => stop(),
    });
    let turnId: string | undefined;
    let aborted = false;
    let settled = false;
    const lifetime = new AbortController();
    const outcomes = new Map<string, ToolOutcome>();
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      lifetime.abort();
      registration.release();
      unwatchExit();
      call.abortSignal?.removeEventListener("abort", onAbort);
      finish();
    };
    const stop = async () => {
      aborted = true;
      lifetime.abort();
      if (turnId)
        await rpc
          .request("turn/interrupt", { threadId, turnId }, EmptyResponse)
          .catch(() => undefined);
      setTimeout(
        () => settle(() => controller.close()),
        INTERRUPT_GRACE_MS,
      ).unref();
    };
    const onAbort = () => void stop();
    const translator = new TurnTranslator({
      rootThreadId: threadId,
      jsonMode: call.responseFormat?.type === "json",
      asyncQuestions: createAsyncQuestions({
        rpc,
        signal: lifetime.signal,
        ask: (question, signal) =>
          request.requests?.(question, { signal }) ??
          Promise.resolve({ answers: {} }),
        requested: (question) =>
          translator.questionRequested(question, "request_user_input_async"),
        answered: (id, output, isError) =>
          translator.questionAnswered(id, output, isError),
      }),
      emit: (part) => {
        if (!settled) controller.enqueue(part);
      },
      takeToolOutcome: (id) => {
        const outcome = outcomes.get(id);
        outcomes.delete(id);
        return outcome;
      },
      adopt: (childThreadId) => registration.adopt(childThreadId),
      onFinished: (status) =>
        settle(() => {
          if (status === "completed" && !aborted)
            continuation.keep(call.prompt, configuration, threadId);
          controller.close();
        }),
      onError: (error) => settle(() => controller.error(error)),
    });
    const context: ThreadContext = {
      notification: (method, params) => {
        try {
          const event = parseNotification(method, params);
          if (event) translator.handle(event);
        } catch (error) {
          settle(() => controller.error(error));
        }
      },
      request: async (serverRequest, { signal }) => {
        if (serverRequest.method === "item/tool/call")
          return this.callTool(
            serverRequest.params,
            tools,
            translator,
            outcomes,
            call.abortSignal,
          );
        const isQuestion =
          serverRequest.method === "item/tool/requestUserInput";
        if (isQuestion && !translator.questionRequested(serverRequest.params))
          return declineServerRequest(serverRequest.method);
        try {
          const answer =
            (await request.requests?.(serverRequest, {
              signal: AbortSignal.any([
                signal,
                lifetime.signal,
                ...(call.abortSignal ? [call.abortSignal] : []),
              ]),
            })) ?? declineServerRequest(serverRequest.method);
          if (isQuestion)
            translator.questionAnswered(
              serverRequest.params.itemId,
              answer,
              false,
            );
          return answer;
        } catch (error) {
          if (isQuestion)
            translator.questionAnswered(
              serverRequest.params.itemId,
              "Question cancelled",
              true,
            );
          throw error;
        }
      },
    };
    const registration = router.register(threadId, context);
    const unwatchExit = rpc.onExit((error) =>
      settle(() => controller.error(error)),
    );
    call.abortSignal?.addEventListener("abort", onAbort, { once: true });
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({
      type: "response-metadata",
      id: generateId(),
      timestamp: new Date(),
      modelId: this.modelId,
    });

    const effort =
      request.effort ??
      (call.reasoning && call.reasoning !== "provider-default"
        ? call.reasoning
        : undefined);
    const params: TurnStartParams = {
      threadId,
      input: prompt.input,
      model: this.modelId,
      cwd: request.cwd,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy:
        permissions.sandbox === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : permissions.sandbox === "workspace-write"
            ? {
                type: "workspaceWrite",
                writableRoots: request.cwd ? [request.cwd] : [],
                networkAccess: false,
                excludeSlashTmp: true,
                excludeTmpdirEnvVar: true,
              }
            : { type: "readOnly", networkAccess: false },
      effort,
      summary: request.summary ?? "auto",
      ...(call.responseFormat?.type === "json" && call.responseFormat.schema
        ? { outputSchema: call.responseFormat.schema }
        : {}),
    };
    try {
      const started = await rpc.request(
        "turn/start",
        params,
        TurnStartResponse,
      );
      turnId = started.turn.id;
      if (aborted) void stop();
    } catch (error) {
      settle(() => controller.error(error));
      throw error;
    }
    return { stream, request: { body: params } };
  }

  async doGenerate(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    return collectGeneration(await this.doStream(call), this.modelId);
  }
}
