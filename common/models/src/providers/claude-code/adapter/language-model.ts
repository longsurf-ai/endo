// Purpose: Implements the AI SDK language model as one Claude Agent SDK query per request.
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateId, parseProviderOptions } from "@ai-sdk/provider-utils";
import {
  getSessionInfo,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Continuation } from "@openchart/models/providers/continuation";
import { collectGeneration } from "@openchart/models/providers/generate";
import { z } from "zod";
import { convertPrompt, userContent } from "./history";
import { nativeQuery } from "./native-query";
import { createHostToolServer, HOST_SERVER, type HostTool } from "./tools";
import { TurnTranslator } from "./translate";

export const CLAUDE_CODE_PROVIDER = "claude-code";

const EFFORTS: ReadonlySet<string> = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const ProviderOptions = z.object({
  cwd: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z
    .enum([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ])
    .optional(),
  allowDangerouslySkipPermissions: z.boolean().optional(),
  sandbox: z
    .object({
      enabled: z.boolean(),
      failIfUnavailable: z.boolean().optional(),
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z.boolean().optional(),
    })
    .optional(),
  tools: z
    .custom<Record<string, HostTool>>(
      (value) => typeof value === "object" && value !== null,
    )
    .optional(),
  /** Host approval policy for native tools; OpenChart tools are pre-approved. */
  canUseTool: z
    .custom<CanUseTool>((value) => typeof value === "function")
    .optional(),
});

/** Request-scoped options under the `claude-code` provider namespace. */
export type ClaudeCodeProviderOptions = z.infer<typeof ProviderOptions>;

export interface ClaudeCodeLanguageModelOptions {
  modelId: string;
  executable: string;
  env: Record<string, string>;
  continuation: Continuation;
  /** Aborts every request when the provider is disposed. */
  disposal: AbortSignal;
}

/**
 * Each call owns one query and its CLI process. An append-only prompt resumes
 * the remembered session with only the new user message; otherwise a fresh
 * session receives the replayed transcript. OpenChart tools run in-process
 * through the SDK's MCP server; approvals go to the host policy. Abort
 * interrupts the query and the stream closes on the CLI's terminal result.
 * @example const model = provider.languageModel("sonnet");
 */
export class ClaudeCodeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = CLAUDE_CODE_PROVIDER;
  readonly supportedUrls = {};
  readonly modelId: string;

  constructor(private readonly options: ClaudeCodeLanguageModelOptions) {
    this.modelId = options.modelId;
  }

  async doStream(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>> {
    call.abortSignal?.throwIfAborted();
    this.options.disposal.throwIfAborted();
    const request =
      (await parseProviderOptions({
        provider: CLAUDE_CODE_PROVIDER,
        providerOptions: call.providerOptions,
        schema: ProviderOptions,
      })) ?? {};
    const prompt = convertPrompt(call.prompt);
    const tools = request.tools ?? {};
    const host =
      Object.keys(tools).length > 0
        ? createHostToolServer(tools, call.abortSignal)
        : undefined;
    // Changing policy starts a fresh session so prior grants cannot survive a downgrade.
    const permissions = {
      permissionMode: request.permissionMode,
      allowDangerouslySkipPermissions: request.allowDangerouslySkipPermissions,
      sandbox: request.sandbox,
    };
    const configuration = JSON.stringify({
      permissions,
      tools: Object.entries(tools).map(([name, tool]) => [
        name,
        tool.description,
        z.toJSONSchema(tool.inputSchema),
      ]),
    });
    const { continuation } = this.options;
    let resume = continuation.take(call.prompt, configuration);
    // A remembered session may have been deleted; check before committing input to it.
    if (resume && !(await getSessionInfo(resume).catch(() => undefined)))
      resume = undefined;

    const effort = request.effort ?? call.reasoning;
    const abort = new AbortController();
    const queryOptions: Options = {
      model: this.modelId,
      cwd: request.cwd,
      env: this.options.env,
      pathToClaudeCodeExecutable: this.options.executable,
      strictMcpConfig: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      ...permissions,
      abortController: abort,
      ...(prompt.system
        ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: prompt.system,
            },
          }
        : {}),
      ...(host
        ? {
            mcpServers: { [HOST_SERVER]: host.server },
            allowedTools: host.allowedTools,
          }
        : {}),
      ...(request.canUseTool ? { canUseTool: request.canUseTool } : {}),
      ...(effort && EFFORTS.has(effort)
        ? { effort: effort as EffortLevel }
        : {}),
      ...(resume ? { resume } : {}),
      ...(call.responseFormat?.type === "json" && call.responseFormat.schema
        ? {
            outputFormat: {
              type: "json_schema",
              schema: call.responseFormat.schema as Record<string, unknown>,
            },
          }
        : {}),
    };

    let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (next) => {
        controller = next;
      },
      // A cancelled consumer takes no more parts; the CLI is still told to stop.
      cancel: () => settle(interrupt),
    });
    let sessionId: string | undefined;
    let settled = false;
    let releaseInput!: () => void;
    const inputDone = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      call.abortSignal?.removeEventListener("abort", interrupt);
      this.options.disposal.removeEventListener("abort", interrupt);
      releaseInput();
      finish();
    };
    const translator = new TurnTranslator({
      jsonMode: call.responseFormat?.type === "json",
      emit: (part) => {
        if (!settled) controller.enqueue(part);
      },
      takeOutcome: (id) => host?.takeOutcome(id),
      onSession: (id) => {
        sessionId = id;
      },
      onFinished: (status) =>
        settle(() => {
          if (status === "completed" && sessionId)
            continuation.keep(call.prompt, configuration, sessionId);
          controller.close();
        }),
    });

    // Streaming input keeps the control channel open for interrupts; the
    // single user message is followed by silence until the turn settles.
    const content = userContent(prompt, resume === undefined);
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: "",
      };
      await inputDone;
    }
    const query = nativeQuery({ prompt: input(), options: queryOptions });
    const interrupt = () => {
      translator.markInterrupted();
      query.interrupt().catch(() => abort.abort());
    };
    call.abortSignal?.addEventListener("abort", interrupt, { once: true });
    this.options.disposal.addEventListener("abort", interrupt, { once: true });

    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({
      type: "response-metadata",
      id: generateId(),
      timestamp: new Date(),
      modelId: this.modelId,
    });
    void (async () => {
      try {
        for await (const message of query) translator.handle(message);
        translator.end("error");
      } catch (error) {
        if (settled) return;
        // An interrupted CLI reports its stop as an error result; that is the expected end.
        if (call.abortSignal?.aborted || this.options.disposal.aborted)
          translator.end("interrupted");
        else settle(() => controller.error(error));
      } finally {
        query.close();
      }
    })();
    return {
      stream,
      request: { body: { model: this.modelId, resume, content } },
    };
  }

  async doGenerate(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    return collectGeneration(await this.doStream(call), this.modelId);
  }
}
