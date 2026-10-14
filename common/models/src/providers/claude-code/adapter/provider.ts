// Purpose: Creates AI SDK models over the Claude Agent SDK and discovers native login and models.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import type {
  ModelInfo,
  SDKControlGetUsageResponse,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createContinuation } from "@openchart/models/providers/continuation";
import { z } from "zod";
import { claudeEnvironment } from "./environment";
import { ClaudeCodeLanguageModel } from "./language-model";
import { nativeQuery } from "./native-query";
import { HOST_TOOL_TIMEOUT_MS } from "./tools";

const execute = promisify(execFile);
const AuthStatus = z.object({ loggedIn: z.boolean() });

export interface ClaudeCodeProviderSettings {
  /** Absolute managed executable supplied by the host. */
  executable: string;
  /** Extra subprocess environment merged over the sanitized host environment. */
  env?: Record<string, string>;
}

export interface ClaudeCodeProvider extends ProviderV4 {
  /**
   * Reads native models without submitting a prompt. Returns undefined only for
   * an explicit logged-out state; startup and SDK failures reject.
   * @example const models = await provider.discoverModels();
   */
  discoverModels(): Promise<ModelInfo[] | undefined>;
  /**
   * Reads the signed-in plan's usage without submitting a prompt. Returns
   * undefined only for an explicit logged-out state; startup and SDK failures
   * reject. Never cached.
   * @example const usage = await provider.readUsage();
   */
  readUsage(): Promise<SDKControlGetUsageResponse | undefined>;
  /** Interrupts active requests and forgets remembered sessions. Idempotent. */
  dispose(): Promise<void>;
}

/** `claude auth status --json` exits 1 with a JSON body when logged out. */
async function isLoggedIn(
  executable: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<boolean> {
  const args = ["auth", "status", "--json"];
  try {
    const { stdout } = await execute(executable, args, {
      env,
      signal,
      timeout: 10_000,
    });
    return AuthStatus.parse(JSON.parse(stdout)).loggedIn;
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code === 1 && typeof failure.stdout === "string") {
      const status = AuthStatus.parse(JSON.parse(failure.stdout));
      if (!status.loggedIn) return false;
    }
    throw error;
  }
}

/**
 * Construction performs no I/O. Each model call owns one CLI process; the
 * provider owns only the shared environment and the session hints.
 * @example
 * const provider = createClaudeCodeProvider({ executable });
 * try { const model = provider.languageModel("sonnet"); }
 * finally { await provider.dispose(); }
 */
export function createClaudeCodeProvider(
  settings: ClaudeCodeProviderSettings,
): ClaudeCodeProvider {
  const env = claudeEnvironment({
    MCP_TOOL_TIMEOUT: String(HOST_TOOL_TIMEOUT_MS),
    ...settings.env,
  });
  const continuation = createContinuation();
  const disposal = new AbortController();
  const assertActive = () => {
    if (disposal.signal.aborted)
      throw new Error("Claude Code provider is disposed");
  };
  /** Answers one control request on a query that never sends a user message; undefined when logged out. */
  async function control<T>(
    read: (query: ReturnType<typeof nativeQuery>) => Promise<T>,
  ): Promise<T | undefined> {
    assertActive();
    const signal = AbortSignal.any([
      disposal.signal,
      AbortSignal.timeout(30_000),
    ]);
    if (!(await isLoggedIn(settings.executable, env, signal))) return undefined;
    // Keep stdin open so the control channel can answer without a user message.
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const query = nativeQuery({
      // eslint-disable-next-line require-yield -- Control reads must never send a user message.
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await idle;
      })(),
      options: {
        pathToClaudeCodeExecutable: settings.executable,
        env,
        strictMcpConfig: true,
        persistSession: false,
        abortController,
      },
    });
    try {
      return await read(query);
    } finally {
      release();
      query.close();
      signal.removeEventListener("abort", abort);
    }
  }
  return {
    specificationVersion: "v4",
    languageModel: (modelId) => {
      assertActive();
      if (!modelId.trim())
        throw new NoSuchModelError({ modelId, modelType: "languageModel" });
      return new ClaudeCodeLanguageModel({
        modelId,
        executable: settings.executable,
        env,
        continuation,
        disposal: disposal.signal,
      });
    },
    embeddingModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
    discoverModels: () => control((query) => query.supportedModels()),
    // SDK 0.3.280 marks this control request experimental. The binding maps its
    // shape; recheck both on every SDK upgrade.
    readUsage: () =>
      control((query) =>
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }),
      ),
    async dispose() {
      disposal.abort(new Error("Claude Code provider is disposed"));
      continuation.clear();
    },
  };
}
