// Purpose: Runs one native OpenCode turn with request-owned tools, approvals and cleanup.
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parseProviderOptions } from "@ai-sdk/provider-utils";
import type { Continuation } from "@openchart/models/providers/continuation";
import { collectGeneration } from "@openchart/models/providers/generate";
import { z } from "zod";
import { AcpConnection } from "./acp";
import { convertPrompt } from "./history";
import {
  startHostToolServer,
  type HostTool,
  type HostToolServer,
} from "./host-tools";
import { requestEnvironment } from "./native-config";
import { TurnTranslator } from "./translate";
import { answerForm, type OpenCodeAnswer } from "./questions";

/** Provider-options namespace used by the native SDK. */
export const OPENCODE_PROVIDER = "opencode";
/** Native approval details; the request callback grants only one execution. */
export interface OpenCodePermission {
  kind: string;
  name: string;
  title: string;
  input: Record<string, unknown>;
}
const Options = z.object({
  cwd: z.string().min(1),
  effort: z.string().optional(),
  permissionMode: z.enum(["ask", "auto", "full-access"]),
  approve: z.custom<
    (request: OpenCodePermission, signal: AbortSignal) => Promise<boolean>
  >((value) => typeof value === "function"),
  answer: z
    .custom<OpenCodeAnswer>((value) => typeof value === "function")
    .optional(),
  tools: z.custom<Record<string, HostTool>>(
    (value) => typeof value === "object" && value !== null,
  ),
});
/**
 * Per-call context under `providerOptions.opencode`. The caller owns tools and
 * callbacks, which must honor cancellation; cleanup awaits active calls. Native
 * policies remain authoritative. Missing/invalid context fails before native I/O.
 * @example const options = { cwd, tools, permissionMode: "ask", approve } satisfies OpenCodeProviderOptions;
 */
export type OpenCodeProviderOptions = z.infer<typeof Options>;
const Session = z.looseObject({ sessionId: z.string() });
const Permission = z.looseObject({
  toolCall: z.looseObject({
    name: z.string().optional(),
    kind: z.string().nullish(),
    title: z.string().nullish(),
    rawInput: z.record(z.string(), z.unknown()).optional(),
  }),
  options: z.array(z.looseObject({ optionId: z.string(), kind: z.string() })),
});

export interface OpenCodeLanguageModelOptions {
  modelId: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  hostServerName?: string;
  disposal: AbortSignal;
  continuation: Continuation;
  active?: Set<Promise<unknown>>;
}

/**
 * Borrows provider lifetime and runs an isolated ACP process per turn. Every call
 * supplies full history and request callbacks; native resume is a private hint.
 * Validated structured output uses a schema-bound MCP submission tool, with no
 * automatic prompt replay. Cleanup completes before the output stream closes.
 * @example const model = new OpenCodeLanguageModel(settings);
 */
export class OpenCodeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = OPENCODE_PROVIDER;
  readonly supportedUrls = {};
  readonly modelId: string;
  constructor(private readonly settings: OpenCodeLanguageModelOptions) {
    this.modelId = settings.modelId;
  }

  async doGenerate(call: LanguageModelV4CallOptions) {
    return collectGeneration(await this.doStream(call), this.modelId);
  }

  async doStream(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>> {
    call.abortSignal?.throwIfAborted();
    this.settings.disposal.throwIfAborted();
    const request = await parseProviderOptions({
      provider: OPENCODE_PROVIDER,
      providerOptions: call.providerOptions,
      schema: Options,
    });
    if (!request) throw new Error("OpenCode requires Endo request context");
    this.settings.disposal.throwIfAborted();
    call.abortSignal?.throwIfAborted();
    const hostServerName = this.settings.hostServerName ?? "endo";
    const fresh = convertPrompt(call.prompt, false);
    const schema =
      call.responseFormat?.type === "json"
        ? (call.responseFormat.schema ?? { type: "object" as const })
        : undefined;
    const tools = { ...request.tools };
    const submission = "endo_submit_output";
    let structured: unknown;
    let submitted = false;
    if (schema) {
      if (Object.hasOwn(tools, submission))
        throw new Error("Reserved OpenCode output tool name is already in use");
      tools[submission] = {
        description:
          "Submit the final structured response exactly once, matching this schema. This completes the Endo request.",
        inputSchema: z.fromJSONSchema(
          schema as Parameters<typeof z.fromJSONSchema>[0],
        ),
        execute: async (input) => {
          if (submitted)
            throw new Error("Structured output has already been submitted");
          structured = input;
          submitted = true;
          return { accepted: true };
        },
        toModelOutput: () => "Structured response accepted. End the turn now.",
      };
    }
    const system = [
      fresh.system,
      `You are running inside Endo. Application tools are available under the ${hostServerName} MCP server. Use their exact schemas and preserve tool results. The supplied transcript is authoritative history; its tool calls already ran.`,
      schema
        ? `For the final response, call ${submission} in the ${hostServerName} MCP server with the schema-valid value. Do not substitute prose for this call.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const configuration = JSON.stringify({
      model: this.modelId,
      effort: request.effort ?? call.reasoning,
      cwd: request.cwd,
      system,
      permissions: request.permissionMode,
      tools: Object.entries(tools).map(([name, tool]) => [
        name,
        tool.description,
        z.toJSONSchema(tool.inputSchema),
      ]),
    });
    const remembered = this.settings.continuation.take(
      call.prompt,
      configuration,
    );
    const native = requestEnvironment(
      this.settings.env,
      this.modelId,
      system,
      request.permissionMode,
    );
    const turn = new AbortController();
    const cancel = () => {
      turn.abort(call.abortSignal?.reason ?? this.settings.disposal.reason);
    };
    call.abortSignal?.addEventListener("abort", cancel, { once: true });
    this.settings.disposal.addEventListener("abort", cancel, { once: true });
    if (call.abortSignal?.aborted || this.settings.disposal.aborted) cancel();
    let acp: AcpConnection | undefined;
    let host: HostToolServer | undefined;
    let sessionId: string | undefined;
    let prompting = false;
    let abandoned = false;
    let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const translator = new TurnTranslator((part) => {
      if (!abandoned) controller.enqueue(part);
    }, schema !== undefined);
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (value) => {
        controller = value;
      },
      cancel: () => {
        abandoned = true;
        turn.abort();
      },
    });
    const stop = () => {
      if (prompting && sessionId) acp?.notify("session/cancel", { sessionId });
      // Native cancellation gets a short drain window before forced teardown.
      const timer = setTimeout(() => {
        void acp?.close();
      }, 5_000);
      timer.unref();
      cleanupTimers.push(timer);
    };
    const cleanupTimers: Array<ReturnType<typeof setTimeout>> = [];
    turn.signal.addEventListener("abort", stop, { once: true });
    const run = async () => {
      try {
        turn.signal.throwIfAborted();
        host = await startHostToolServer(
          tools,
          turn.signal,
          {
            started: (id, name, input, nativeSession) => {
              if (name !== submission)
                translator.hostStarted(id, name, input, nativeSession);
            },
            finished: (id, name, output, error) => {
              if (name !== submission)
                translator.hostFinished(id, name, output, error);
            },
          },
          hostServerName,
        );
        turn.signal.throwIfAborted();
        acp = new AcpConnection({
          executable: this.settings.executable,
          cwd: request.cwd,
          env: native.env,
          timeoutMs: 10 * 60_000,
          notification: (method, params) => {
            if (method === "opencode/session/child_update") {
              const child = z
                .looseObject({ rootSessionId: z.string() })
                .parse(params);
              if (child.rootSessionId === sessionId) translator.child(params);
              return;
            }
            if (method !== "session/update") return;
            const notice = z
              .looseObject({ sessionId: z.string(), update: z.unknown() })
              .parse(params);
            if (notice.sessionId === sessionId)
              translator.update(notice.update);
          },
          request: async (method, params) => {
            turn.signal.throwIfAborted();
            if (method === "elicitation/create")
              return answerForm(params, request.answer, turn.signal);
            if (method !== "session/request_permission")
              throw new Error(`Unsupported OpenCode request ${method}`);
            const permission = Permission.parse(params);
            const tool = permission.toolCall;
            const allowed =
              request.permissionMode === "full-access" ||
              (await request.approve(
                {
                  name: tool.name ?? "native_tool",
                  kind: tool.kind ?? "other",
                  title: tool.title ?? "",
                  input: tool.rawInput ?? {},
                },
                turn.signal,
              ));
            const choice = permission.options.find(
              (option) =>
                option.kind === (allowed ? "allow_once" : "reject_once"),
            );
            return choice
              ? { outcome: { outcome: "selected", optionId: choice.optionId } }
              : { outcome: { outcome: "cancelled" } };
          },
        });
        await acp.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            elicitation: { form: {} },
            _meta: { "opencode/child-session-updates": true },
          },
        });
        const parameters = { cwd: request.cwd, mcpServers: [host.server] };
        if (remembered) {
          try {
            z.looseObject({ configOptions: z.array(z.unknown()) }).parse(
              await acp.request("session/resume", {
                ...parameters,
                sessionId: remembered,
              }),
            );
            sessionId = remembered;
          } catch {
            turn.signal.throwIfAborted();
          }
        }
        const resumed = sessionId !== undefined;
        sessionId ??= Session.parse(
          await acp.request("session/new", parameters),
        ).sessionId;
        translator.bindRoot(sessionId);
        await acp.request("session/set_config_option", {
          sessionId,
          configId: "mode",
          value: native.agent,
        });
        await acp.request("session/set_config_option", {
          sessionId,
          configId: "model",
          value: this.modelId,
        });
        if (request.effort ?? call.reasoning)
          await acp.request("session/set_config_option", {
            sessionId,
            configId: "effort",
            value: request.effort ?? call.reasoning,
          });
        turn.signal.throwIfAborted();
        prompting = true;
        const result = await acp.request("session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: convertPrompt(call.prompt, resumed).text },
          ],
        });
        prompting = false;
        translator.finish(
          turn.signal.aborted ? { stopReason: "cancelled" } : result,
          submitted ? structured : undefined,
        );
        if (!turn.signal.aborted)
          this.settings.continuation.keep(
            call.prompt,
            configuration,
            sessionId,
          );
      } catch (error) {
        if (turn.signal.aborted) translator.finish({ stopReason: "cancelled" });
        else translator.fail(error);
      } finally {
        prompting = false;
        call.abortSignal?.removeEventListener("abort", cancel);
        this.settings.disposal.removeEventListener("abort", cancel);
        turn.signal.removeEventListener("abort", stop);
        for (const timer of cleanupTimers) clearTimeout(timer);
        turn.abort();
        await host?.close();
        await acp?.close();
        if (!abandoned) controller.close();
      }
    };
    controller.enqueue({ type: "stream-start", warnings: [] });
    const running = run();
    this.settings.active?.add(running);
    void running.finally(() => this.settings.active?.delete(running));
    return { stream };
  }
}
