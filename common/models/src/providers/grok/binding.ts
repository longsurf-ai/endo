// Purpose: Grok as OpenChart's native provider: discovery, catalog enrichment, quota, sign-in, and request policy.
import type { ModelsDev } from "@openchart/models/catalog";
import type {
  AvailableModel,
  ModelProvider,
} from "@openchart/models/model-provider";
import { GROK, classifyModels } from "@openchart/models/model-tiers";
import type {
  NativeProvider,
  ProviderRequestContext,
} from "@openchart/models/native-provider";
import type {
  ProviderPermissionAsk,
  ProviderPermissionMode,
} from "@openchart/models/provider-permission";
import type { ProviderQuestionAsk } from "@openchart/models/provider-question";
import { ProviderQuota } from "@openchart/models/provider-quota";
import { hasExecutable } from "@openchart/models/providers/executable";
import { catalogModelMetadata } from "@openchart/models/providers/model-catalog";
import { assertTrue } from "@openchart/utils/assert";
import {
  GROK_PROVIDER,
  createGrokProvider,
  type GrokPermission,
  type GrokProvider,
  type GrokProviderOptions,
  type GrokQuestions,
  type NativeModel,
  type NativeUsageReport,
} from "@openchart/models/providers/grok/adapter/index";
import { grokTiers } from "./tiers";

/** Effort order for variants; the CLI lists them highest first. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
/** Plan periods `_x.ai/billing` reports; unknown periods stay unknown. */
const PERIOD_MINUTES: Readonly<Record<string, number>> = {
  USAGE_PERIOD_TYPE_DAILY: 24 * 60,
  USAGE_PERIOD_TYPE_WEEKLY: 7 * 24 * 60,
};

/**
 * Grok imports Claude Code and Cursor skills, rules, agents, hooks and MCP
 * servers by default; OpenChart runs those agents separately, so their
 * configuration stays out of Grok sessions. The host pins the installed
 * version, so the CLI must not replace itself.
 */
const ENVIRONMENT: Record<string, string> = {
  GROK_DISABLE_AUTOUPDATER: "1",
  ...Object.fromEntries(
    ["CLAUDE", "CURSOR"].flatMap((vendor) =>
      ["SKILLS", "RULES", "AGENTS", "HOOKS", "MCPS"].map((part) => [
        `GROK_${vendor}_${part}_ENABLED`,
        "0",
      ]),
    ),
  ),
};

function enrichModel(
  model: NativeModel,
  catalog: ModelsDev.Model | undefined,
): AvailableModel {
  const metadata = catalogModelMetadata(catalog);
  const efforts = model._meta?.reasoningEfforts?.map((effort) => effort.value);
  return {
    ...metadata,
    kind: "language",
    providerID: GROK,
    id: model.modelId,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(efforts && {
      availableVariants: EFFORTS.filter((effort) => efforts.includes(effort)),
    }),
    capabilities: {
      ...metadata.capabilities,
      reasoning:
        model._meta?.supportsReasoningEffort ?? metadata.capabilities.reasoning,
      toolcall: true,
      // ACP turns here accept text only.
      attachment: false,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
    },
  };
}

/** One account meter for the plan's credit period; API keys bill per call. */
function translateUsage(report: NativeUsageReport): ProviderQuota {
  if (report.subscription.meta?.auth_mode === "ApiKey")
    return { status: "not_applicable" };
  const { creditUsagePercent, currentPeriod } = report.billing.config;
  const minutes = currentPeriod && PERIOD_MINUTES[currentPeriod.type];
  return ProviderQuota.parse({
    status: "ready",
    meters: [
      {
        scope: { kind: "account" },
        ...(minutes && { window: { kind: "duration", minutes } }),
        usage: { kind: "percent", usedPercent: creditUsagePercent },
        ...(currentPeriod?.end && {
          resetsAt: new Date(currentPeriod.end).toISOString(),
        }),
      },
    ],
  });
}

// @agent invariant: construction contains only stable binding policy. The
// reusable model handle is stateless and every run-scoped capability enters
// doStream through providerOptions.
/**
 * Creates a lazy binding with fixed CLI policy and instance-owned disposal.
 * The subscription check establishes sign-in and `_x.ai/models/list` the model
 * list; exact xAI catalog matches enrich metadata. Higher tiers come first,
 * then mapping preference, then unclassified native order. Construction
 * performs no I/O; the host owns installation.
 * @example
 * const binding = grok.createModelProvider(catalog, executable);
 * try {
 *   const available = await binding.discover();
 *   if (available.status === "ready") binding.sdk.languageModel(available.provider.models[0]!.id);
 * } finally { await binding.dispose(); }
 */
function createGrokModelProvider(
  catalog: ReturnType<typeof ModelsDev.create>,
  executable: string,
): ModelProvider {
  let sdk: GrokProvider | undefined;
  let disposal: Promise<void> | undefined;
  function assertActive() {
    if (disposal) throw new Error("Grok binding is disposed");
  }
  function getSDK(): GrokProvider {
    assertActive();
    if (sdk) return sdk;
    assertTrue(hasExecutable(executable), "Grok executable not found");
    return (sdk = createGrokProvider({ executable, env: ENVIRONMENT }));
  }

  return {
    id: GROK,
    get sdk() {
      return getSDK();
    },
    async discover() {
      assertActive();
      if (!hasExecutable(executable)) return { status: "not_installed" };
      const native = await getSDK().discoverModels();
      assertActive();
      // Device-code sign-in prints a URL and code, then waits; it needs no terminal.
      if (native === undefined)
        return {
          status: "authentication_required",
          login: { executable, args: ["login", "--device-auth"] },
        };
      const providers = await catalog.get();
      assertActive();
      const models = native.map((model) =>
        enrichModel(model, providers.xai?.models[model.modelId]),
      );
      return {
        status: "ready",
        provider: {
          id: GROK,
          name: "Grok",
          models: classifyModels(grokTiers, models),
        },
      };
    },
    async readQuota() {
      assertActive();
      assertTrue(hasExecutable(executable), "Grok executable not found");
      const usage = await getSDK().readUsage();
      assertActive();
      assertTrue(usage !== undefined, "Grok is not signed in");
      return translateUsage(usage);
    },
    dispose: () => (disposal ??= sdk?.dispose() ?? Promise.resolve()),
  };
}

/** Grok's tool kinds and variants as OpenChart permissions and patterns. */
function permissionFor({ kind, input }: GrokPermission) {
  const string = (key: string) =>
    typeof input[key] === "string" && input[key] !== ""
      ? (input[key] as string)
      : undefined;
  if (kind === "execute" || input.variant === "Bash")
    return { permission: "run_command", pattern: string("command") ?? "*" };
  const path =
    string("file_path") ?? string("path") ?? string("target_file") ?? "*";
  if (kind === "edit" || kind === "delete" || kind === "move")
    return { permission: "edit", pattern: path };
  if (kind === "fetch")
    return { permission: "web_fetch", pattern: string("url") ?? "*" };
  if (typeof input.tool_name === "string")
    return { permission: "mcp_tool", pattern: input.tool_name };
  return { permission: kind, pattern: JSON.stringify(input) ?? "*" };
}

function approval(
  ask: ProviderPermissionAsk,
): NonNullable<GrokProviderOptions["approve"]> {
  return async (request) => {
    const { permission, pattern } = permissionFor(request);
    try {
      await ask({
        permission,
        patterns: [pattern],
        metadata: { ...request },
        always: [pattern],
      });
      return true;
    } catch {
      return false;
    }
  };
}

function answering(
  askQuestion: ProviderQuestionAsk,
): NonNullable<GrokProviderOptions["answer"]> {
  return async ({ questions }: GrokQuestions, signal) => {
    const reply = await askQuestion(
      {
        questions: questions.map((question, index) => ({
          id: String(index),
          header: question.header ?? "",
          question: question.question,
          options: question.options,
          multiple: question.multiSelect,
          allowFreeform: true,
          secret: false,
        })),
      },
      { signal },
    );
    if (reply.type === "skipped") return undefined;
    return Object.fromEntries(
      questions.map((question, index) => [
        question.question,
        (reply.answers[String(index)] ?? []).join(", "),
      ]),
    );
  };
}

const PERMISSION_MODES: Readonly<
  Record<ProviderPermissionMode, GrokProviderOptions["permissionMode"]>
> = {
  ask: "default",
  auto: "auto",
  "full-access": "always-approve",
};

/**
 * Binds one call's cwd, OpenChart tools, and permission mode; never cache the
 * result. `ask` sends every native approval Grok raises to the host; `auto`
 * lets Grok's classifier approve routine work first. Questions reach the host
 * when it can answer them and are skipped otherwise.
 * @example
 * const providerOptions = {[grok.sdkKey]: grok.requestOptions({cwd, tools, permissionMode, askPermission})};
 */
function grokRequestOptions({
  cwd,
  tools,
  permissionMode,
  askPermission,
  askQuestion,
}: ProviderRequestContext): GrokProviderOptions {
  return {
    cwd,
    tools,
    permissionMode: PERMISSION_MODES[permissionMode],
    approve: approval(askPermission),
    ...(askQuestion && { answer: answering(askQuestion) }),
  };
}

/**
 * Grok as OpenChart's native provider.
 * @example
 * const binding = grok.createModelProvider(catalog, executable);
 */
export const grok = {
  id: GROK,
  sdkKey: GROK_PROVIDER,
  createModelProvider: createGrokModelProvider,
  requestOptions: grokRequestOptions,
} satisfies NativeProvider;
