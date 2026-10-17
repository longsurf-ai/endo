// Purpose: Implements the AI SDK language model as one Grok ACP prompt turn per request.
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateId, parseProviderOptions } from "@ai-sdk/provider-utils";
import type { Continuation } from "@openchart/models/providers/continuation";
import { collectGeneration } from "@openchart/models/providers/generate";
import { z } from "zod";
import { AcpConnection, AcpError } from "./acp";
import {
  PermissionRequest,
  PromptResult,
  QuestionRequest,
  SessionUpdate,
  SubagentNotice,
} from "./events";
import { convertPrompt, promptBlocks } from "./history";
import {
  HOST_TOOL_PREFIX,
  startHostToolServer,
  type HostTool,
  type HostToolServer,
} from "./host-tools";
import { TurnTranslator } from "./translate";

export const GROK_PROVIDER = "grok";

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
/** A session that ignores `session/cancel` is closed after this grace period. */
const CANCEL_AFTER_MS = 5_000;

/** One native action awaiting approval; the binding maps it to host permissions. */
export interface GrokPermission {
  /** Grok's tool kind: `execute`, `edit`, `fetch`, `other`, ... */
  kind: string;
  title: string;
  /** Grok's `rawInput`: `{ variant: "Bash", command }`, file edits, MCP calls, ... */
  input: Record<string, unknown>;
}

/** One `ask_user_question` invocation; answers are keyed by question text. */
export interface GrokQuestions {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

const ProviderOptions = z.object({
  cwd: z.string().optional(),
  effort: z.string().optional(),
  /**
   * `always-approve` skips native prompts, `auto` lets Grok's classifier
   * approve routine work, and `default` asks `approve` for everything else.
   */
  permissionMode: z.enum(["default", "auto", "always-approve"]).optional(),
  /** Resolves true to allow one native action; absent hosts deny every prompt. */
  approve: z
    .custom<(request: GrokPermission, signal: AbortSignal) => Promise<boolean>>(
      (value) => typeof value === "function",
    )
    .optional(),
  /** Resolves answers keyed by question text, or undefined to skip; absent hosts skip. */
  answer: z
    .custom<
      (
        request: GrokQuestions,
        signal: AbortSignal,
      ) => Promise<Record<string, string> | undefined>
    >((value) => typeof value === "function")
    .optional(),
  tools: z
    .custom<Record<string, HostTool>>(
      (value) => typeof value === "object" && value !== null,
    )
    .optional(),
});

/** Request-scoped options under the `grok` provider namespace. */
export type GrokProviderOptions = z.infer<typeof ProviderOptions>;

export interface GrokLanguageModelOptions {
  modelId: string;
  executable: string;
  env: Record<string, string>;
  continuation: Continuation;
  /** Aborts every request when the provider is disposed. */
  disposal: AbortSignal;
}

/**
 * Session rules: the system instructions, where OpenChart's tools live, and,
 * for a session that starts from replayed text, that the replay is the
 * conversation's real history rather than pasted content.
 */
function sessionRules(
  system: string | undefined,
  toolNames: string[],
  replayed: boolean,
) {
  const tools =
    toolNames.length > 0
      ? `OpenChart's tools are MCP tools; call them with use_tool by their catalog keys (${toolNames
          .map((name) => HOST_TOOL_PREFIX + name)
          .join(
            ", ",
          )}). Instructions may name them without the "${HOST_TOOL_PREFIX}" prefix.`
      : undefined;
  const history = replayed
    ? `The first message replays this conversation's earlier turns from OpenChart under "Conversation so far". They happened: their tool calls already ran, and the results shown are what OpenChart kept of them. Answer from them; use tools only for what they cannot answer.`
    : undefined;
  return [system, tools, history].filter(Boolean).join("\n\n");
}

/**
 * Each call owns one `grok agent stdio` process and one prompt turn. An
 * append-only prompt resumes its remembered session with only the new user
 * message; otherwise a fresh session receives the system instructions as
 * rules and the replayed transcript as text. OpenChart tools run in-process
 * behind a per-request MCP server passed to the session. Native approvals and
 * questions reach the host through request callbacks. Abort sends
 * `session/cancel`; the turn then finishes as interrupted.
 * @example const model = provider.languageModel("grok-4.7");
 */
export class GrokLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = GROK_PROVIDER;
  readonly supportedUrls = {};
  readonly modelId: string;

  constructor(private readonly options: GrokLanguageModelOptions) {
    this.modelId = options.modelId;
  }

  async doStream(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>> {
    call.abortSignal?.throwIfAborted();
    this.options.disposal.throwIfAborted();
    const request =
      (await parseProviderOptions({
        provider: GROK_PROVIDER,
        providerOptions: call.providerOptions,
        schema: ProviderOptions,
      })) ?? {};
    const prompt = convertPrompt(call.prompt);
    const tools = request.tools ?? {};
    const toolNames = Object.keys(tools);
    const permissionMode = request.permissionMode ?? "default";
    // Changing tools, instructions or policy starts a fresh session.
    const configuration = JSON.stringify({
      permissionMode,
      system: prompt.system,
      tools: Object.entries(tools).map(([name, tool]) => [
        name,
        tool.description,
        z.toJSONSchema(tool.inputSchema),
      ]),
    });
    const { continuation, env, executable } = this.options;
    const remembered = continuation.take(call.prompt, configuration);
    const effort = request.effort ?? call.reasoning;
    const jsonSchema =
      call.responseFormat?.type === "json"
        ? (call.responseFormat.schema ?? { type: "object" })
        : undefined;
    const permission =
      permissionMode === "always-approve"
        ? { yoloMode: true }
        : permissionMode === "auto"
          ? { autoMode: true }
          : {};

    let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (next) => {
        controller = next;
      },
      // A cancelled consumer takes no more parts; Grok is still told to stop.
      cancel: () => {
        if (prompting && sessionId) acp.notify("session/cancel", { sessionId });
        settle(() => {});
      },
    });
    const turn = new AbortController();
    let sessionId: string | undefined;
    let host: HostToolServer | undefined;
    let prompting = false;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      call.abortSignal?.removeEventListener("abort", interrupt);
      this.options.disposal.removeEventListener("abort", interrupt);
      turn.abort();
      host?.close();
      acp.close();
      finish();
    };
    const translator = new TurnTranslator({
      jsonMode: jsonSchema !== undefined,
      emit: (part) => {
        if (!settled) controller.enqueue(part);
      },
      onFinished: (status) =>
        settle(() => {
          if (status === "completed" && sessionId)
            continuation.keep(call.prompt, configuration, sessionId);
          controller.close();
        }),
    });

    const acp = new AcpConnection({
      executable,
      cwd: request.cwd,
      env,
      handlers: {
        notification: (method, params) => {
          if (!prompting) return;
          const message = params as { sessionId?: unknown; update?: unknown };
          if (typeof message?.sessionId !== "string") return;
          if (method === "session/update") {
            const update = SessionUpdate.safeParse(message.update);
            if (update.success)
              translator.update(message.sessionId, update.data);
          } else if (method === "_x.ai/session_notification") {
            const notice = SubagentNotice.safeParse(message.update);
            if (notice.success) translator.subagent(notice.data);
          }
        },
        request: async (method, params) => {
          if (method === "session/request_permission")
            return this.permission(
              PermissionRequest.parse(params),
              request,
              turn.signal,
            );
          if (method === "_x.ai/ask_user_question")
            return this.question(
              QuestionRequest.parse(params),
              request,
              turn.signal,
            );
          throw new Error(`Unsupported request ${method}`);
        },
      },
    });
    const interrupt = () => {
      translator.markInterrupted();
      // Before the prompt there is nothing to cancel; the turn ends at once.
      if (!prompting || !sessionId)
        return translator.fail(new Error("aborted"));
      acp.notify("session/cancel", { sessionId });
      setTimeout(
        () => translator.fail(new Error("Grok did not stop")),
        CANCEL_AFTER_MS,
      ).unref();
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

    const run = async () => {
      if (toolNames.length > 0)
        host = await startHostToolServer(tools, call.abortSignal, {
          started: (id, name, input) =>
            translator.hostToolStarted(id, name, input),
          finished: (id, name, output, isError) =>
            translator.hostToolFinished(id, name, output, isError),
        });
      const mcpServers = host ? [host.server] : [];
      await acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "openchart", version: "1.0.0" },
      });
      // A remembered session may have been deleted; resume it before committing input.
      if (remembered)
        sessionId = await acp
          .request("session/resume", {
            sessionId: remembered,
            cwd: request.cwd ?? process.cwd(),
            mcpServers,
            _meta: permission,
          })
          .then(
            () => remembered,
            (error: unknown) => {
              if (error instanceof AcpError) return undefined;
              throw error;
            },
          );
      const fresh = sessionId === undefined;
      if (!sessionId) {
        const rules = sessionRules(
          prompt.system,
          toolNames,
          prompt.replay !== "",
        );
        const created = z.object({ sessionId: z.string() }).parse(
          await acp.request("session/new", {
            cwd: request.cwd ?? process.cwd(),
            mcpServers,
            _meta: { ...permission, ...(rules ? { rules } : {}) },
          }),
        );
        sessionId = created.sessionId;
      }
      await acp.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: this.modelId,
      });
      if (effort && EFFORTS.has(effort))
        await acp.request("session/set_config_option", {
          sessionId,
          configId: "reasoning_effort",
          value: effort,
        });
      if (turn.signal.aborted) return;
      translator.bindRoot(sessionId);
      prompting = true;
      const result = await acp.request("session/prompt", {
        sessionId,
        prompt: promptBlocks(prompt, fresh),
        ...(jsonSchema ? { _meta: { outputSchema: jsonSchema } } : {}),
      });
      translator.result(PromptResult.parse(result));
    };
    run().catch((error: unknown) => {
      if (settled) return;
      translator.fail(error);
    });

    return {
      stream,
      request: {
        // The remembered session this call resumes; a missing one starts fresh.
        body: { model: this.modelId, effort, session: remembered },
      },
    };
  }

  async doGenerate(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    return collectGeneration(await this.doStream(call), this.modelId);
  }

  /** Allows once or rejects once; OpenChart's own MCP tools are pre-approved. */
  private async permission(
    request: PermissionRequest,
    options: GrokProviderOptions,
    signal: AbortSignal,
  ) {
    const input =
      typeof request.toolCall.rawInput === "object" &&
      request.toolCall.rawInput !== null
        ? (request.toolCall.rawInput as Record<string, unknown>)
        : {};
    const host =
      typeof input.tool_name === "string" &&
      input.tool_name.startsWith(HOST_TOOL_PREFIX);
    const allowed =
      host ||
      ((await options
        .approve?.(
          {
            kind: request.toolCall.kind ?? "other",
            title: request.toolCall.title ?? "",
            input,
          },
          signal,
        )
        .catch(() => false)) ??
        false);
    const option =
      request.options.find(
        (choice) => choice.kind === (allowed ? "allow_once" : "reject_once"),
      ) ??
      request.options.find((choice) =>
        choice.kind.startsWith(allowed ? "allow" : "reject"),
      );
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  /** Answers `ask_user_question`; a skipped or unavailable host skips the interview. */
  private async question(
    request: QuestionRequest,
    options: GrokProviderOptions,
    signal: AbortSignal,
  ) {
    const answers = await options.answer?.(
      {
        questions: request.questions.map((question) => ({
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            description: option.description ?? "",
          })),
          multiSelect: question.multiSelect === true,
        })),
      },
      signal,
    );
    return answers
      ? { outcome: "accepted", answers }
      : { outcome: "skip_interview" };
  }
}
