// Purpose: Creates AI SDK models over the Antigravity CLI and reads native models and plan usage.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import { createContinuation } from "@openchart/models/providers/continuation";
import { CommandResult, NativeUsageReport } from "./events";
import { AntigravityLanguageModel } from "./language-model";

const execute = promisify(execFile);
const SIGNED_OUT = /sign in|authentication required|not logged in/i;
const MODEL_LINE = /^(\S+)\t(.+)$/;

export interface AntigravityProviderSettings {
  /** Absolute managed executable supplied by the host. */
  executable: string;
  /** Extra subprocess environment merged over the host environment. */
  env?: Record<string, string>;
}

/** One `antigravity models` row: an effort-specific ID and its display name. */
export interface NativeModel {
  id: string;
  name: string;
}

export interface AntigravityProvider extends ProviderV4 {
  /**
   * Lists native models without starting a turn. Returns undefined only when
   * the CLI reports that no account is signed in; other failures reject.
   * @example const models = await provider.discoverModels();
   */
  discoverModels(): Promise<NativeModel[] | undefined>;
  /**
   * Reads the signed-in plan's meters through `/usage`, which spends no model
   * tokens. Returns undefined only when signed out; never cached.
   * @example const usage = await provider.readUsage();
   */
  readUsage(): Promise<NativeUsageReport | undefined>;
  /** Interrupts active requests and forgets remembered conversations. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Construction performs no I/O. Each model call owns one CLI process; the
 * provider owns only the shared environment and the conversation hints.
 * @example
 * const provider = createAntigravityProvider({ executable });
 * try { const model = provider.languageModel("gemini-3.8-flash"); }
 * finally { await provider.dispose(); }
 */
export function createAntigravityProvider(
  settings: AntigravityProviderSettings,
): AntigravityProvider {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (typeof value === "string") env[key] = value;
  Object.assign(env, settings.env);
  const continuation = createContinuation();
  const disposal = new AbortController();
  const assertActive = () => {
    if (disposal.signal.aborted)
      throw new Error("Antigravity provider is disposed");
  };
  /** Runs a short command; nonzero exits reject with the CLI's output attached. */
  const run = (args: string[]) => {
    assertActive();
    const pending = execute(settings.executable, args, {
      env,
      signal: AbortSignal.any([disposal.signal, AbortSignal.timeout(30_000)]),
    });
    // The CLI reads piped stdin as a prompt; closing it makes a signed-out CLI
    // fail at once instead of starting an interactive sign-in.
    pending.child.stdin?.end();
    return pending;
  };
  return {
    specificationVersion: "v4",
    languageModel: (modelId) => {
      assertActive();
      if (!modelId.trim())
        throw new NoSuchModelError({ modelId, modelType: "languageModel" });
      return new AntigravityLanguageModel({
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
    async discoverModels() {
      // Rows go to stdout; progress and the sign-in notice go to stderr. A
      // signed-out CLI prints the notice, then exits 1.
      const result = await run(["models"]).catch(
        (error: { stderr?: string }) => {
          if (SIGNED_OUT.test(error.stderr ?? "")) return undefined;
          throw error;
        },
      );
      if (!result) return undefined;
      const { stdout, stderr } = result;
      const models = stdout.split("\n").flatMap((line) => {
        const match = MODEL_LINE.exec(line.trim());
        return match ? [{ id: match[1]!, name: match[2]!.trim() }] : [];
      });
      if (models.length > 0) return models;
      throw new Error(
        `Antigravity model discovery failed: ${(stderr || stdout).trim()}`,
      );
    },
    async readUsage() {
      // A failed read, e.g. signed out, still prints its JSON result before exiting 1.
      const { stdout, stderr } = await run([
        "-p",
        "/usage",
        "--output-format",
        "json",
      ]).catch((error: { stdout?: string; stderr?: string }) => {
        if (!error.stdout) throw error;
        return { stdout: error.stdout, stderr: error.stderr ?? "" };
      });
      const result = CommandResult.parse(JSON.parse(stdout));
      if (result.status === "SUCCESS" && result.command)
        return NativeUsageReport.parse(result.command.data);
      if (SIGNED_OUT.test(`${result.error ?? ""}\n${stderr}`)) return undefined;
      throw new Error(
        `Antigravity usage read failed: ${result.error ?? result.status}`,
      );
    },
    async dispose() {
      disposal.abort(new Error("Antigravity provider is disposed"));
      continuation.clear();
    },
  };
}
