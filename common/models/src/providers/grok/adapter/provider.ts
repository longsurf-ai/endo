// Purpose: Creates AI SDK models over the Grok CLI and reads native models and plan usage over ACP.
import { NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import { createContinuation } from "@openchart/models/providers/continuation";
import { AcpConnection, AcpError } from "./acp";
import {
  Billing,
  ModelList,
  Subscription,
  type NativeModel,
  type NativeUsageReport,
} from "./events";
import { GrokLanguageModel } from "./language-model";

/** Short reads never take longer than this. */
const READ_TIMEOUT_MS = 30_000;

export interface GrokProviderSettings {
  /** Absolute managed executable supplied by the host. */
  executable: string;
  /** Extra subprocess environment merged over the host environment. */
  env?: Record<string, string>;
}

export interface GrokProvider extends ProviderV4 {
  /**
   * Lists native models without starting a session. Returns undefined only
   * when no account is signed in; other failures reject.
   * @example const models = await provider.discoverModels();
   */
  discoverModels(): Promise<NativeModel[] | undefined>;
  /**
   * Reads the signed-in plan's subscription and credit use, which spends no
   * model tokens. Returns undefined only when signed out; never cached.
   * @example const usage = await provider.readUsage();
   */
  readUsage(): Promise<NativeUsageReport | undefined>;
  /** Interrupts active requests and forgets remembered sessions. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Construction performs no I/O. Each model call owns one agent process; the
 * provider owns only the shared environment and the session hints. Reads run
 * one short-lived agent that answers `x.ai` extension requests and never
 * creates a session.
 * @example
 * const provider = createGrokProvider({ executable });
 * try { const model = provider.languageModel("grok-4.7"); }
 * finally { await provider.dispose(); }
 */
export function createGrokProvider(
  settings: GrokProviderSettings,
): GrokProvider {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (typeof value === "string") env[key] = value;
  Object.assign(env, settings.env);
  const continuation = createContinuation();
  const disposal = new AbortController();
  const assertActive = () => {
    if (disposal.signal.aborted) throw new Error("Grok provider is disposed");
  };

  /** Runs `read` against a fresh, initialized agent that is closed afterwards. */
  async function withAgent<T>(read: (acp: AcpConnection) => Promise<T>) {
    assertActive();
    const acp = new AcpConnection({
      executable: settings.executable,
      env,
      handlers: {
        notification: () => {},
        request: async (method) => {
          throw new Error(`Unsupported request ${method}`);
        },
      },
    });
    const stop = () => acp.close();
    const timer = setTimeout(stop, READ_TIMEOUT_MS);
    disposal.signal.addEventListener("abort", stop, { once: true });
    try {
      await acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "openchart", version: "1.0.0" },
      });
      return await read(acp);
    } finally {
      clearTimeout(timer);
      disposal.signal.removeEventListener("abort", stop);
      acp.close();
    }
  }

  const subscription = async (acp: AcpConnection) =>
    Subscription.parse(await acp.request("_x.ai/auth/check_subscription", {}));

  return {
    specificationVersion: "v4",
    languageModel: (modelId) => {
      assertActive();
      if (!modelId.trim())
        throw new NoSuchModelError({ modelId, modelType: "languageModel" });
      return new GrokLanguageModel({
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
    discoverModels: () =>
      withAgent(async (acp) => {
        // Signed out, Grok still lists a default catalog; sign-in decides availability.
        if (!(await subscription(acp)).authenticated) return undefined;
        const { result } = ModelList.parse(
          await acp.request("_x.ai/models/list", {}),
        );
        if (result.availableModels.length > 0) return result.availableModels;
        throw new Error("Grok model discovery returned no models");
      }),
    readUsage: () =>
      withAgent(async (acp) => {
        const account = await subscription(acp);
        if (!account.authenticated) return undefined;
        const billing = await acp
          .request("_x.ai/billing", {})
          .catch((error: unknown) => {
            if (error instanceof AcpError && /auth/i.test(error.message))
              return undefined;
            throw error;
          });
        if (billing === undefined) return undefined;
        return { subscription: account, billing: Billing.parse(billing) };
      }),
    async dispose() {
      disposal.abort(new Error("Grok provider is disposed"));
      continuation.clear();
    },
  };
}
