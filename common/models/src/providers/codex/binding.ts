// Purpose: Codex as OpenChart's native provider: discovery, catalog enrichment, quota, and request policy.
import type { ModelsDev } from "@openchart/models/catalog";
import {
  catalogModelMetadata,
  modelModalities,
} from "@openchart/models/providers/model-catalog";
import type {
  AvailableModel,
  ModelProvider,
  ProviderDiscoveryResult,
} from "@openchart/models/model-provider";
import { CODEX, classifyModels } from "@openchart/models/model-tiers";
import type {
  NativeProvider,
  ProviderRequestContext,
} from "@openchart/models/native-provider";
import type {
  ProviderPermissionAsk,
  ProviderPermissionMode,
} from "@openchart/models/provider-permission";
import type { ProviderQuestionAsk } from "@openchart/models/provider-question";
import {
  ProviderQuota,
  type QuotaMeter,
  type QuotaScope,
  type QuotaWindow,
} from "@openchart/models/provider-quota";
import { hasExecutable } from "@openchart/models/providers/executable";
import { assertTrue } from "@openchart/utils/assert";
import {
  CODEX_PROVIDER,
  createCodexProvider,
  type AccountRateLimitsReadResponse,
  type CodexModel,
  type CodexProviderOptions,
  type ServerRequest,
} from "@openchart/models/providers/codex/adapter/index";
import { codexTiers } from "./tiers";

/** Every bucket window becomes one meter; `normalModelSlug` marks a model bucket. */
function translateRateLimits(
  native: AccountRateLimitsReadResponse,
): ProviderQuota {
  const snapshots = native.rateLimitsByLimitId
    ? Object.values(native.rateLimitsByLimitId)
    : [native.rateLimits];
  const meters = snapshots.flatMap((snapshot) => {
    const scope: QuotaScope = snapshot.normalModelSlug
      ? { kind: "model", name: snapshot.limitName ?? snapshot.normalModelSlug }
      : { kind: "account" };
    return [snapshot.primary, snapshot.secondary].flatMap((limit) => {
      if (!limit) return [];
      const window: QuotaWindow | undefined =
        limit.windowDurationMins == null
          ? undefined
          : { kind: "duration", minutes: limit.windowDurationMins };
      const meter: QuotaMeter = {
        scope,
        ...(window && { window }),
        usage: { kind: "percent", usedPercent: limit.usedPercent },
        ...(limit.resetsAt != null && {
          resetsAt: new Date(limit.resetsAt * 1000).toISOString(),
        }),
      };
      return [meter];
    });
  });
  const plan = snapshots.find(
    (snapshot) => snapshot.planType && snapshot.planType !== "unknown",
  )?.planType;
  return ProviderQuota.parse({
    status: "ready",
    ...(plan && { plan }),
    ...(native.ordinaryUsageAllowed != null && {
      blocked: !native.ordinaryUsageAllowed,
    }),
    meters,
  });
}

function enrichModel(
  native: CodexModel,
  catalog: ModelsDev.Model | undefined,
): AvailableModel {
  const metadata = catalogModelMetadata(catalog);
  const efforts = native.supportedReasoningEfforts?.map(
    (option) => option.reasoningEffort,
  );
  return {
    ...metadata,
    kind: "language",
    providerID: CODEX,
    id: native.model,
    name: native.displayName,
    availableVariants: efforts,
    capabilities: {
      temperature: catalog?.temperature,
      reasoning:
        efforts === undefined
          ? catalog?.reasoning
          : efforts.some((effort) => effort !== "none"),
      attachment:
        native.inputModalities === undefined
          ? catalog?.attachment
          : native.inputModalities.some((modality) => modality !== "text"),
      toolcall: catalog?.tool_call,
      input: modelModalities(
        native.inputModalities ?? catalog?.modalities?.input,
      ),
      output: metadata.capabilities.output,
    },
  };
}

// Native delegation stays enabled through four levels. Request policy below
// overrides native permission defaults. Known gap, by decision: the app-server
// inherits the operator's personal `~/.codex` configuration and MCP servers.
/**
 * Creates one binding with fixed policy and a lazy native process. Construction
 * performs no I/O. Native account/model discovery determines availability;
 * exact OpenAI catalog matches enrich metadata without adding models. Results
 * are grouped by descending tier, then same-tier preference, then unclassified
 * models in native order. Repeated discovery reads native state again; refresh
 * replaces the binding after managed installation or login changes. The host
 * owns installation and version pins. Startup, protocol, and catalog failures throw.
 * @example
 * const binding = codex.createModelProvider(catalog, executable);
 * try {
 *   const available = await binding.discover();
 *   if (available.status === "ready") binding.sdk.languageModel(available.provider.models[0]!.id);
 * } finally {
 *   await binding.dispose();
 * }
 */
function createCodexModelProvider(
  catalog: ReturnType<typeof ModelsDev.create>,
  executable: string,
): ModelProvider {
  let sdk: ReturnType<typeof createCodexProvider> | undefined;
  let disposal: Promise<void> | undefined;
  function assertActive() {
    if (disposal) throw new Error("Codex binding is disposed");
  }
  function getSDK() {
    assertActive();
    if (sdk) return sdk;
    assertTrue(hasExecutable(executable), "Codex executable not found");
    return (sdk = createCodexProvider({
      executable,
      config: {
        "agents.max_depth": 4,
        "features.default_mode_request_user_input": true,
        check_for_update_on_startup: false,
      },
    }));
  }

  async function discover(): Promise<ProviderDiscoveryResult> {
    assertActive();
    if (!hasExecutable(executable)) return { status: "not_installed" };
    const provider = getSDK();
    const account = await provider.readAccount();
    assertActive();
    if (account.requiresOpenaiAuth && account.account === null)
      return {
        status: "authentication_required",
        login: { executable, args: ["login"] },
      };

    // Include hidden picker entries too: they are still native model IDs.
    const models: CodexModel[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await provider.listModels({ includeHidden: true, cursor });
      assertActive();
      for (const model of page.models) {
        assertTrue(
          !ids.has(model.model),
          `Duplicate Codex SDK model ID: ${model.model}`,
        );
        ids.add(model.model);
        models.push(model);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) {
        assertTrue(
          !cursors.has(cursor),
          `Repeated Codex model cursor: ${cursor}`,
        );
        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    const metadata = (await catalog.get()).openai?.models;
    assertActive();
    return {
      status: "ready",
      provider: {
        id: CODEX,
        name: "Codex",
        models: classifyModels(
          codexTiers,
          models.map((model) => enrichModel(model, metadata?.[model.model])),
        ),
      },
    };
  }

  return {
    id: CODEX,
    get sdk() {
      return getSDK();
    },
    discover,
    async readQuota() {
      assertActive();
      assertTrue(hasExecutable(executable), "Codex executable not found");
      const provider = getSDK();
      const { account, requiresOpenaiAuth } = await provider.readAccount();
      assertActive();
      if (account === null) {
        assertTrue(!requiresOpenaiAuth, "Codex is not logged in");
        return { status: "not_applicable" };
      }
      // Only ChatGPT plans meter usage; API keys and Bedrock bill per call.
      if (account.type !== "chatgpt") return { status: "not_applicable" };
      const native = await provider.readRateLimits();
      assertActive();
      return translateRateLimits(native);
    },
    dispose: () => (disposal ??= sdk?.dispose() ?? Promise.resolve()),
  };
}

async function decide(
  ask: ProviderPermissionAsk,
  input: Parameters<ProviderPermissionAsk>[0],
) {
  try {
    await ask(input);
    return true;
  } catch {
    return false;
  }
}

/** Maps native approval requests onto OpenChart permissions; other kinds fail closed. */
function codexRequestPolicy(
  ask: ProviderPermissionAsk,
  mode: ProviderPermissionMode,
  askQuestion?: ProviderQuestionAsk,
): NonNullable<CodexProviderOptions["requests"]> {
  const approve = (input: Parameters<ProviderPermissionAsk>[0]) =>
    mode === "full-access" ? Promise.resolve(true) : decide(ask, input);
  return async (request: ServerRequest, options) => {
    switch (request.method) {
      case "item/tool/requestUserInput": {
        if (!askQuestion) return { answers: {} };
        const reply = await askQuestion(
          {
            questions: request.params.questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              options: question.options ?? [],
              multiple: false,
              allowFreeform: question.isOther || !question.options?.length,
              secret: question.isSecret,
            })),
          },
          options,
        );
        return {
          answers:
            reply.type === "skipped"
              ? {}
              : Object.fromEntries(
                  Object.entries(reply.answers).map(([id, answers]) => [
                    id,
                    { answers },
                  ]),
                ),
        };
      }
      case "item/commandExecution/requestApproval": {
        const pattern = request.params.command ?? "*";
        const allowed = await approve({
          permission: "run_command",
          patterns: [pattern],
          metadata: { ...request.params },
          always: [pattern],
        });
        return { decision: allowed ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const pattern = request.params.grantRoot ?? "*";
        const allowed = await approve({
          permission: "edit",
          patterns: [pattern],
          metadata: { ...request.params },
          always: [pattern],
        });
        return { decision: allowed ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval": {
        const allowed = await approve({
          permission: "native_permissions",
          patterns: [request.params.cwd],
          metadata: { ...request.params },
          always: [request.params.cwd],
        });
        return {
          permissions: allowed ? request.params.permissions : {},
          scope: "turn",
        };
      }
      case "mcpServer/elicitation/request": {
        const elicitation = (request.params.request ?? request.params) as {
          message?: unknown;
          _meta?: { codex_approval_kind?: unknown } | null;
        };
        if (elicitation._meta?.codex_approval_kind !== "mcp_tool_call")
          return { action: "decline", content: null };
        const pattern =
          typeof elicitation.message === "string"
            ? elicitation.message
            : request.params.serverName;
        const allowed = await approve({
          permission: "mcp_tool",
          patterns: [pattern],
          metadata: { ...request.params },
          always: [pattern],
        });
        return allowed
          ? { action: "accept", content: {} }
          : { action: "decline", content: null };
      }
      default:
        return undefined;
    }
  };
}

/**
 * Binds one call's cwd, OpenChart tools, and native approval policy.
 * @example
 * const providerOptions = {[codex.sdkKey]: codex.requestOptions({cwd, tools, permissionMode, askPermission})};
 */
function codexRequestOptions({
  cwd,
  tools,
  permissionMode,
  askPermission,
  askQuestion,
}: ProviderRequestContext): CodexProviderOptions {
  return {
    cwd,
    tools,
    approvalPolicy: permissionMode === "full-access" ? "never" : "on-request",
    sandbox:
      permissionMode === "full-access"
        ? "danger-full-access"
        : "workspace-write",
    approvalsReviewer: permissionMode === "auto" ? "auto_review" : "user",
    requests: codexRequestPolicy(askPermission, permissionMode, askQuestion),
  };
}

/** GPT-5 models default to medium effort; explicit options and the selected variant override it. */
function defaultOptions(model: AvailableModel): Record<string, unknown> {
  return model.id.includes("gpt-5") ? { effort: "medium" } : {};
}

/**
 * Codex as OpenChart's native provider.
 * @example
 * const binding = codex.createModelProvider(catalog, executable);
 */
export const codex = {
  id: CODEX,
  sdkKey: CODEX_PROVIDER,
  createModelProvider: createCodexModelProvider,
  requestOptions: codexRequestOptions,
  defaultOptions,
} satisfies NativeProvider;
