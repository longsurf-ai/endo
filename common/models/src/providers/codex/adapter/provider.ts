// Purpose: Owns one lazy Codex app-server process and creates AI SDK models over it.
import { NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import { createContinuation } from "@openchart/models/providers/continuation";
import { CodexLanguageModel } from "./language-model";
import {
  AccountRateLimitsReadResponse,
  AccountReadResponse,
  ModelListResponse,
  type CodexModel,
} from "./protocol";
import { createCodexRpc, type SpawnCodex } from "./rpc";
import { createThreadRouter } from "./threads";

export interface CodexProviderSettings {
  /** Absolute managed executable supplied by the host. */
  executable: string;
  env?: NodeJS.ProcessEnv;
  /** Native config overrides for every thread, e.g. `agents.max_depth`. */
  config?: Record<string, unknown>;
  /** Test seam replacing process creation. */
  spawn?: SpawnCodex;
}

export interface CodexProvider extends ProviderV4 {
  /** Reads native login state without starting login. @example await provider.readAccount(); */
  readAccount(): Promise<AccountReadResponse>;
  /** Reads the account's plan rate limits; never cached. @example await provider.readRateLimits(); */
  readRateLimits(): Promise<AccountRateLimitsReadResponse>;
  /** Reads one page of native models; pass nextCursor until it is null. */
  listModels(params: {
    cursor?: string;
    includeHidden?: boolean;
  }): Promise<{ models: CodexModel[]; nextCursor: string | null }>;
  /** Terminates the process; every model handle fails afterwards. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Construction performs no I/O; the process starts on the first request and
 * serves every session of this provider. Disposal is terminal.
 * @example
 * const provider = createCodexProvider({ executable });
 * try { const model = provider.languageModel("gpt-5.6-luna"); }
 * finally { await provider.dispose(); }
 */
export function createCodexProvider(
  settings: CodexProviderSettings,
): CodexProvider {
  const rpc = createCodexRpc({
    executable: settings.executable,
    env: settings.env,
    spawn: settings.spawn,
  });
  const router = createThreadRouter(rpc);
  const continuation = createContinuation();
  let disposed = false;
  const assertActive = () => {
    if (disposed) throw new Error("Codex provider is disposed");
  };
  return {
    specificationVersion: "v4",
    languageModel: (modelId) => {
      assertActive();
      if (!modelId.trim())
        throw new NoSuchModelError({ modelId, modelType: "languageModel" });
      return new CodexLanguageModel({
        modelId,
        rpc,
        router,
        continuation,
        config: settings.config,
      });
    },
    embeddingModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
    readAccount: () => {
      assertActive();
      return rpc.request(
        "account/read",
        { refreshToken: false },
        AccountReadResponse,
      );
    },
    readRateLimits: () => {
      assertActive();
      // Reset-credit details are a separate backend lookup the meter never shows.
      return rpc.request(
        "account/rateLimits/read",
        { excludeResetCreditDetails: true },
        AccountRateLimitsReadResponse,
      );
    },
    listModels: async (params) => {
      assertActive();
      const page = await rpc.request("model/list", params, ModelListResponse);
      return { models: page.data, nextCursor: page.nextCursor };
    },
    dispose: async () => {
      disposed = true;
      continuation.clear();
      await rpc.close();
    },
  };
}
