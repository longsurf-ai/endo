// Purpose: Claude Code as OpenChart's native provider: discovery, catalog enrichment, quota, and request policy.
import type {
  CanUseTool,
  ModelInfo,
  SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { ModelsDev } from "@openchart/models/catalog";
import { catalogModelMetadata } from "@openchart/models/providers/model-catalog";
import type {
  AvailableModel,
  ModelProvider,
} from "@openchart/models/model-provider";
import { CLAUDE_CODE, classifyModels } from "@openchart/models/model-tiers";
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
  type QuotaUsage,
} from "@openchart/models/provider-quota";
import { hasExecutable } from "@openchart/models/providers/executable";
import { assertTrue } from "@openchart/utils/assert";
import {
  CLAUDE_CODE_PROVIDER,
  createClaudeCodeProvider,
  HOST_TOOL_PREFIX,
  type ClaudeCodeProvider,
  type ClaudeCodeProviderOptions,
} from "@openchart/models/providers/claude-code/adapter/index";
import { claudeCodeTiers } from "./tiers";

const SESSION_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
type NativeWindow = { utilization: number | null; resets_at: string | null };

/** Extra-usage fields beyond the SDK declaration: amounts are minor units scaled by `decimal_places`. */
const ExtraUsage = z.looseObject({
  is_enabled: z.boolean(),
  monthly_limit: z.number().nullable(),
  used_credits: z.number().nullable(),
  utilization: z.number().nullable(),
  currency: z.string().nullish(),
  decimal_places: z.number().int().nonnegative().optional(),
});

function windowMeter(
  scope: QuotaScope,
  minutes: number,
  native: NativeWindow | null | undefined,
): QuotaMeter | undefined {
  if (!native) return undefined;
  const usage: QuotaUsage | undefined =
    native.utilization === null
      ? undefined
      : { kind: "percent", usedPercent: native.utilization };
  return {
    scope,
    window: { kind: "duration", minutes },
    ...(usage && { usage }),
    // The usage endpoint writes a +00:00 offset; the contract wants Z.
    ...(native.resets_at !== null && {
      resetsAt: new Date(native.resets_at).toISOString(),
    }),
  };
}

function extraUsageMeter(native: unknown): QuotaMeter | undefined {
  if (native == null) return undefined;
  const extra = ExtraUsage.parse(native);
  if (!extra.is_enabled) return undefined;
  const scale =
    extra.decimal_places === undefined ? undefined : 10 ** extra.decimal_places;
  const usage: QuotaUsage | undefined =
    scale !== undefined &&
    extra.monthly_limit !== null &&
    extra.monthly_limit > 0 &&
    extra.used_credits !== null &&
    extra.currency != null
      ? {
          kind: "spend",
          used: extra.used_credits / scale,
          limit: extra.monthly_limit / scale,
          currency: extra.currency,
        }
      : extra.utilization === null
        ? undefined
        : { kind: "percent", usedPercent: extra.utilization };
  return {
    scope: { kind: "account" },
    window: { kind: "month" },
    ...(usage && { usage }),
  };
}

/** Session and weekly windows, then model buckets, then enabled extra usage. */
function translateUsage(usage: SDKControlGetUsageResponse): ProviderQuota {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || limits === null)
    return { status: "not_applicable" };
  const account: QuotaScope = { kind: "account" };
  const model = (name: string): QuotaScope => ({ kind: "model", name });
  // Older CLIs report fixed Opus/Sonnet buckets instead of the named list.
  const buckets = limits.model_scoped
    ? limits.model_scoped.map((bucket) =>
        windowMeter(model(bucket.display_name), WEEK_MINUTES, bucket),
      )
    : [
        windowMeter(model("Opus"), WEEK_MINUTES, limits.seven_day_opus),
        windowMeter(model("Sonnet"), WEEK_MINUTES, limits.seven_day_sonnet),
      ];
  const meters = [
    windowMeter(account, SESSION_MINUTES, limits.five_hour),
    windowMeter(account, WEEK_MINUTES, limits.seven_day),
    ...buckets,
    extraUsageMeter(limits.extra_usage),
  ].filter((meter) => meter !== undefined);
  return ProviderQuota.parse({
    status: "ready",
    ...(usage.subscription_type && { plan: usage.subscription_type }),
    meters,
  });
}

function enrichModel(
  native: ModelInfo,
  catalog: ModelsDev.Model | undefined,
): AvailableModel {
  const metadata = catalogModelMetadata(catalog);
  return {
    ...metadata,
    kind: "language",
    providerID: CLAUDE_CODE,
    id: native.value,
    aliases: native.resolvedModel ? [native.resolvedModel] : [],
    name: native.displayName,
    description: native.description,
    availableVariants:
      native.supportedEffortLevels ??
      (native.supportsEffort === false ? [] : undefined),
    capabilities: {
      ...metadata.capabilities,
      // No selectable effort levels does not rule out fixed-budget reasoning.
      reasoning:
        native.supportsAdaptiveThinking === true ||
        native.supportedEffortLevels?.length
          ? true
          : metadata.capabilities.reasoning,
    },
  };
}

// @agent invariant: construction contains only stable binding policy. The
// reusable model handle is stateless and every run-scoped capability enters
// doStream through providerOptions.
/**
 * Creates a lazy binding with fixed CLI policy and instance-owned disposal.
 * Native login status establishes availability; SDK discovery owns model IDs,
 * names, and efforts. Exact resolvedModel catalog matches enrich metadata.
 * Higher tiers come first, then mapping preference, then unclassified native
 * order. Construction performs no I/O; the host owns installation.
 * @example
 * const binding = claudeCode.createModelProvider(catalog, executable);
 * try {
 *   const available = await binding.discover();
 *   if (available.status === "ready") binding.sdk.languageModel(available.provider.models[0]!.id);
 * } finally { await binding.dispose(); }
 */
function createClaudeCodeModelProvider(
  catalog: ReturnType<typeof ModelsDev.create>,
  executable: string,
): ModelProvider {
  let sdk: ClaudeCodeProvider | undefined;
  let disposal: Promise<void> | undefined;
  function assertActive() {
    if (disposal) throw new Error("Claude Code binding is disposed");
  }
  function getSDK(): ClaudeCodeProvider {
    assertActive();
    if (sdk) return sdk;
    assertTrue(hasExecutable(executable), "Claude Code executable not found");
    return (sdk = createClaudeCodeProvider({
      executable,
      env: {
        // Agent tool results must wait for the subagent to finish: a background
        // result would seal the child early and drop its later output
        // (protocol.md ordering invariant 4).
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    }));
  }

  return {
    id: CLAUDE_CODE,
    get sdk() {
      return getSDK();
    },
    async discover() {
      assertActive();
      if (!hasExecutable(executable)) return { status: "not_installed" };
      const native = await getSDK().discoverModels();
      assertActive();
      if (native === undefined)
        return {
          status: "authentication_required",
          login: { executable, args: ["auth", "login"] },
        };
      const metadata = (await catalog.get()).anthropic?.models;
      assertActive();
      const ids = new Set<string>();
      const models = native
        // `default` is a moving CLI selection alias, not a distinct model.
        .filter((model) => model.value !== "default")
        .map((model) => {
          assertTrue(
            !ids.has(model.value),
            `Duplicate Claude SDK model ID: ${model.value}`,
          );
          ids.add(model.value);
          return enrichModel(
            model,
            metadata?.[model.resolvedModel ?? model.value],
          );
        });
      return {
        status: "ready",
        provider: {
          id: CLAUDE_CODE,
          name: "Claude Code",
          models: classifyModels(claudeCodeTiers, models),
        },
      };
    },
    async readQuota() {
      assertActive();
      assertTrue(hasExecutable(executable), "Claude Code executable not found");
      const usage = await getSDK().readUsage();
      assertActive();
      assertTrue(usage !== undefined, "Claude Code is not logged in");
      return translateUsage(usage);
    },
    dispose: () => (disposal ??= sdk?.dispose() ?? Promise.resolve()),
  };
}

function permissionForTool(toolName: string) {
  if (toolName === "Bash") return "run_command";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName))
    return "edit";
  return toolName.toLowerCase();
}

function patternForTool(toolName: string, input: Record<string, unknown>) {
  if (toolName === "Bash" && typeof input.command === "string")
    return input.command;
  for (const key of ["file_path", "notebook_path", "path", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return JSON.stringify(input) ?? "*";
}

const AskUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string(),
        options: z.array(
          z.object({ label: z.string(), description: z.string() }),
        ),
        multiSelect: z.boolean(),
      }),
    )
    .min(1)
    .refine(
      (questions) =>
        new Set(questions.map((question) => question.question)).size ===
        questions.length,
      "Question text must be unique",
    ),
});

/** Maps native tool approvals onto OpenChart permissions; OpenChart's own tools are pre-approved. */
function permissionPolicy(
  ask: ProviderPermissionAsk,
  mode: ProviderPermissionMode,
  askQuestion?: ProviderQuestionAsk,
): CanUseTool {
  return async (toolName, input, options) => {
    const allow = {
      behavior: "allow" as const,
      updatedInput: input,
      toolUseID: options.toolUseID,
      decisionClassification: "user_temporary" as const,
    };
    if (toolName === "AskUserQuestion") {
      const { questions } = AskUserQuestionInput.parse(input);
      const reply = await askQuestion?.(
        {
          questions: questions.map((question, index) => ({
            id: String(index),
            header: question.header,
            question: question.question,
            options: question.options,
            multiple: question.multiSelect,
            allowFreeform: true,
            secret: false,
          })),
        },
        { signal: options.signal },
      );
      if (!reply || reply.type === "skipped")
        return {
          behavior: "deny",
          message:
            "The user skipped these questions. Continue without assuming any answers.",
          toolUseID: options.toolUseID,
        };
      return {
        ...allow,
        updatedInput: {
          ...input,
          answers: Object.fromEntries(
            questions.map((question, index) => [
              question.question,
              reply.answers[String(index)]!.join(", "),
            ]),
          ),
        },
      };
    }
    if (mode === "full-access" || toolName.startsWith(HOST_TOOL_PREFIX))
      return allow;
    const pattern = patternForTool(toolName, input);
    try {
      await ask({
        permission: permissionForTool(toolName),
        patterns: [pattern],
        metadata: {
          toolName,
          input,
          // Absent SDK hints must remain absent across the JSON boundary.
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.displayName === undefined
            ? {}
            : { displayName: options.displayName }),
          ...(options.description === undefined
            ? {}
            : { description: options.description }),
          ...(options.decisionReason === undefined
            ? {}
            : { decisionReason: options.decisionReason }),
        },
        always: [pattern],
      });
      return allow;
    } catch (error) {
      return {
        behavior: "deny",
        message: error instanceof Error ? error.message : "Permission denied",
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      };
    }
  };
}

/**
 * Binds one call's cwd, OpenChart tools, and native approval policy; never cache the result.
 * @example
 * const providerOptions = {[claudeCode.sdkKey]: claudeCode.requestOptions({cwd, tools, permissionMode, askPermission})};
 */
function claudeCodeRequestOptions({
  cwd,
  tools,
  permissionMode,
  askPermission,
  askQuestion,
}: ProviderRequestContext): ClaudeCodeProviderOptions {
  const fullAccess = permissionMode === "full-access";
  return {
    cwd,
    tools,
    permissionMode: fullAccess
      ? "bypassPermissions"
      : permissionMode === "auto"
        ? "auto"
        : "default",
    allowDangerouslySkipPermissions: fullAccess,
    sandbox: fullAccess
      ? { enabled: false }
      : {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
        },
    canUseTool: permissionPolicy(askPermission, permissionMode, askQuestion),
  };
}

/** The Claude SDK accepts only `[a-zA-Z0-9_-]` in tool use IDs; IDs stored from other providers are renamed. */
function normalizeMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-call") return part;
          return {
            ...part,
            toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
          };
        }),
      };
    }
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        return {
          ...part,
          toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
        };
      }),
    };
  });
}

/**
 * Claude Code as OpenChart's native provider.
 * @example
 * const binding = claudeCode.createModelProvider(catalog, executable);
 */
export const claudeCode = {
  id: CLAUDE_CODE,
  sdkKey: CLAUDE_CODE_PROVIDER,
  createModelProvider: createClaudeCodeModelProvider,
  requestOptions: claudeCodeRequestOptions,
  normalizeMessages,
} satisfies NativeProvider;
