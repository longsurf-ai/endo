// Purpose: Implements the AI SDK language model as one headless Antigravity CLI turn per request.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateId, parseProviderOptions } from "@ai-sdk/provider-utils";
import type { Continuation } from "@openchart/models/providers/continuation";
import { collectGeneration } from "@openchart/models/providers/generate";
import { z } from "zod";
import { parseEvent } from "./events";
import { convertPrompt, turnText } from "./history";
import {
  startHostToolServer,
  type HostTool,
  type HostToolServer,
} from "./host-tools";
import { ensureHostToolConfig } from "./native-config";
import { TurnTranslator } from "./translate";

export const ANTIGRAVITY_PROVIDER = "antigravity";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const STDERR_LIMIT = 4096;
/** A CLI that ignores SIGINT is killed after this grace period. */
const KILL_AFTER_MS = 5_000;

const ProviderOptions = z.object({
  cwd: z.string().optional(),
  effort: z.string().optional(),
  /** `--dangerously-skip-permissions`; otherwise unapproved native actions are denied. */
  skipPermissions: z.boolean().optional(),
  tools: z
    .custom<Record<string, HostTool>>(
      (value) => typeof value === "object" && value !== null,
    )
    .optional(),
});

/** Request-scoped options under the `antigravity` provider namespace. */
export type AntigravityProviderOptions = z.infer<typeof ProviderOptions>;

export interface AntigravityLanguageModelOptions {
  modelId: string;
  executable: string;
  env: Record<string, string>;
  continuation: Continuation;
  /** Aborts every request when the provider is disposed. */
  disposal: AbortSignal;
}

/**
 * Each call owns one `--input-format stream-json` CLI process that runs a
 * single turn. An append-only prompt resumes the remembered conversation with
 * only the new user message; otherwise a fresh conversation receives the
 * system instructions and replayed transcript as text. OpenChart tools run
 * in-process behind the host MCP server. Abort sends SIGINT; the CLI then
 * reports an interrupted result and the stream finishes as interrupted.
 * @example const model = provider.languageModel("gemini-3.1-pro");
 */
export class AntigravityLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = ANTIGRAVITY_PROVIDER;
  readonly supportedUrls = {};
  readonly modelId: string;

  constructor(private readonly options: AntigravityLanguageModelOptions) {
    this.modelId = options.modelId;
  }

  async doStream(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>> {
    call.abortSignal?.throwIfAborted();
    this.options.disposal.throwIfAborted();
    const request =
      (await parseProviderOptions({
        provider: ANTIGRAVITY_PROVIDER,
        providerOptions: call.providerOptions,
        schema: ProviderOptions,
      })) ?? {};
    const prompt = convertPrompt(call.prompt);
    const tools = request.tools ?? {};
    const toolNames = Object.keys(tools);
    // Changing tools, instructions or policy starts a fresh conversation.
    const configuration = JSON.stringify({
      skipPermissions: request.skipPermissions === true,
      system: prompt.system,
      tools: Object.entries(tools).map(([name, tool]) => [
        name,
        tool.description,
        z.toJSONSchema(tool.inputSchema),
      ]),
    });
    const { continuation, env, executable } = this.options;
    const home = env.HOME ?? os.homedir();
    let resume = continuation.take(call.prompt, configuration);
    // A remembered conversation may have been deleted; check before committing input to it.
    if (
      resume &&
      !existsSync(
        path.join(
          home,
          ".gemini",
          "antigravity-cli",
          "conversations",
          `${resume}.db`,
        ),
      )
    )
      resume = undefined;
    const effort = request.effort ?? call.reasoning;
    const content = turnText(prompt, resume === undefined);
    const jsonSchema =
      call.responseFormat?.type === "json"
        ? call.responseFormat.schema
        : undefined;
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--model",
      this.modelId,
      ...(effort && EFFORTS.has(effort) ? ["--effort", effort] : []),
      ...(resume ? ["--conversation", resume] : []),
      ...(request.skipPermissions ? ["--dangerously-skip-permissions"] : []),
      ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []),
    ];

    let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (next) => {
        controller = next;
      },
      // A cancelled consumer takes no more parts; the CLI is still told to stop.
      cancel: () => settle(interrupt),
    });
    let conversationId: string | undefined;
    let host: HostToolServer | undefined;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      call.abortSignal?.removeEventListener("abort", interrupt);
      this.options.disposal.removeEventListener("abort", interrupt);
      host?.close();
      finish();
    };
    const translator = new TurnTranslator({
      jsonMode: call.responseFormat?.type === "json",
      emit: (part) => {
        if (!settled) controller.enqueue(part);
      },
      onConversation: (id) => {
        conversationId = id;
      },
      onFinished: (status) =>
        settle(() => {
          if (status === "completed" && conversationId)
            continuation.keep(call.prompt, configuration, conversationId);
          controller.close();
        }),
    });

    if (toolNames.length > 0) {
      await ensureHostToolConfig(home);
      host = await startHostToolServer(tools, call.abortSignal, {
        started: (id, name, input) =>
          translator.hostToolStarted(id, name, input),
        finished: (id, name, output, isError) =>
          translator.hostToolFinished(id, name, output, isError),
      });
    }
    const child = spawn(executable, args, {
      cwd: request.cwd,
      env: { ...env, ...host?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    const interrupt = () => {
      translator.markInterrupted();
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS).unref();
    };
    call.abortSignal?.addEventListener("abort", interrupt, { once: true });
    this.options.disposal.addEventListener("abort", interrupt, { once: true });
    // An abort while the tool server was starting fired before these listeners.
    if (call.abortSignal?.aborted || this.options.disposal.aborted) interrupt();
    child.on("error", (error) => settle(() => controller.error(error)));
    // One message, then EOF: the CLI finishes this turn and exits.
    child.stdin.on("error", () => {});
    child.stdin.end(
      `${JSON.stringify({ event: "user", message: { content } })}\n`,
    );

    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({
      type: "response-metadata",
      id: generateId(),
      timestamp: new Date(),
      modelId: this.modelId,
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (settled || !line.trim()) return;
      try {
        const event = parseEvent(line);
        if (event) translator.handle(event);
      } catch (error) {
        settle(() => controller.error(error));
        child.kill("SIGKILL");
      }
    });
    child.on("close", () => {
      lines.close();
      translator.end(stderr.trim());
    });
    return {
      stream,
      request: {
        body: {
          model: this.modelId,
          effort,
          conversation: resume,
          content,
        },
      },
    };
  }

  async doGenerate(
    call: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    return collectGeneration(await this.doStream(call), this.modelId);
  }
}
