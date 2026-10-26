// Purpose: Creates lazy OpenCode model handles and owns discovery/generation disposal.
import { randomBytes } from "node:crypto";
import { NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import { createContinuation } from "@openchart/models/providers/continuation";
import { discoverModels, type OpenCodeModel } from "./discovery";
import { OpenCodeLanguageModel } from "./language-model";

/**
 * Host-owned runtime and configuration context. Paths must be absolute; the
 * adapter never installs a runtime or writes credentials. Environment overrides
 * are copied at construction and inherited by discovery and request processes.
 * @example const settings = { executable: "/runtime/opencode", discoveryDirectory: "/home/user" };
 */
export interface OpenCodeProviderSettings {
  executable: string;
  /** Stable directory used for provider-wide discovery, never a previous request's workspace. */
  discoveryDirectory: string;
  env?: NodeJS.ProcessEnv;
}
/**
 * Lazy native SDK whose model handles borrow its lifetime. Discovery can reject
 * native configuration/protocol failures. Dispose aborts and awaits owned work;
 * subsequent discovery and model access fail. Embeddings and images are unsupported.
 * @example try { await provider.discoverModels(); } finally { await provider.dispose(); }
 */
export interface OpenCodeProvider extends ProviderV4 {
  discoverModels(): Promise<OpenCodeModel[]>;
  dispose(): Promise<void>;
}

/**
 * Creates stateless model handles without I/O. Discovery uses its explicit stable
 * directory; generation validates the chosen native model again in request cwd.
 * Disposal aborts and awaits active work and clears private continuation hints.
 * No native credentials or sessions are exposed to callers.
 * @example
 * const provider = createOpenCodeProvider({executable, discoveryDirectory});
 * try { const models = await provider.discoverModels(); } finally { await provider.dispose(); }
 */
export function createOpenCodeProvider(
  settings: OpenCodeProviderSettings,
): OpenCodeProvider {
  const env = { ...process.env, ...settings.env };
  const hostServerName = `endo_${randomBytes(12).toString("hex")}`;
  const disposal = new AbortController();
  const active = new Set<Promise<unknown>>();
  const continuation = createContinuation();
  let closing: Promise<void> | undefined;
  const assertActive = () => disposal.signal.throwIfAborted();
  return {
    specificationVersion: "v4",
    languageModel(modelId) {
      assertActive();
      return new OpenCodeLanguageModel({
        modelId,
        hostServerName,
        executable: settings.executable,
        env,
        disposal: disposal.signal,
        continuation,
        active,
      });
    },
    embeddingModel(modelId) {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel(modelId) {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
    async discoverModels() {
      assertActive();
      const pending = discoverModels({
        executable: settings.executable,
        cwd: settings.discoveryDirectory,
        env,
        signal: disposal.signal,
        timeoutMs: 30_000,
      });
      active.add(pending);
      try {
        const models = await pending;
        assertActive();
        return models;
      } finally {
        active.delete(pending);
      }
    },
    dispose() {
      if (closing) return closing;
      disposal.abort(new Error("OpenCode provider is disposed"));
      continuation.clear();
      closing = Promise.allSettled([...active]).then(() => {});
      return closing;
    },
  };
}
