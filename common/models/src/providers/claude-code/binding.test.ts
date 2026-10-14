// Purpose: Owner tests for the Claude Code binding's construction policy, discovery, and permission policy.
import { CLAUDE_CODE } from "@openchart/models/model-tiers";
import type { ModelMessage } from "ai";
import type { ProviderPermissionMode } from "@openchart/models/provider-permission";

import type {
  ModelInfo,
  SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsDev } from "@openchart/models/catalog";
import {
  AvailableProvider,
  type ModelProvider,
  type ProviderDiscoveryResult,
} from "@openchart/models/model-provider";

const native = vi.hoisted(() => ({ installed: vi.fn() }));
vi.mock("@openchart/models/providers/executable", () => ({
  hasExecutable: native.installed,
}));
function ready(result: ProviderDiscoveryResult) {
  if (result.status !== "ready")
    throw new Error(`Expected ready, got ${result.status}`);
  return result.provider;
}
const dispose = vi.fn(async () => {});
const discoverModels = vi.fn<() => Promise<ModelInfo[] | undefined>>();
type NativeUsage = Pick<
  SDKControlGetUsageResponse,
  "subscription_type" | "rate_limits_available" | "rate_limits"
>;
const readUsage = vi.fn<() => Promise<NativeUsage | undefined>>();
const catalog = {
  get: vi.fn<() => Promise<Record<string, ModelsDev.Provider>>>(),
};
const bindings: ModelProvider[] = [];
const createClaudeCodeProvider = vi.fn((settings: Record<string, unknown>) => ({
  languageModel: (modelId: string) => ({ modelId, settings }),
  dispose,
  discoverModels,
  readUsage,
}));

vi.doMock("@openchart/models/providers/claude-code/adapter/index", () => ({
  CLAUDE_CODE_PROVIDER: "claude-code",
  createClaudeCodeProvider,
  HOST_TOOL_PREFIX: "mcp__openchart__",
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.installed.mockReset().mockReturnValue(true);
  discoverModels.mockReset().mockResolvedValue([]);
  readUsage.mockReset().mockResolvedValue({
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  });
  catalog.get.mockReset().mockResolvedValue({});
});

afterEach(async () => {
  await Promise.all(bindings.splice(0).map((binding) => binding.dispose()));
});

async function createBinding() {
  const { claudeCode } = await import("./binding");
  const binding = claudeCode.createModelProvider(catalog, "/test/claude");
  bindings.push(binding);
  return binding;
}

async function policy(
  ask = vi.fn(async () => {}),
  permissionMode: ProviderPermissionMode = "ask",
) {
  const { claudeCode } = await import("./binding");
  const options = claudeCode.requestOptions({
    cwd: "/workspace",
    tools: {},
    permissionMode,
    askPermission: ask,
  });
  const decide = (toolName: string, input: Record<string, unknown>) =>
    options.canUseTool!(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: "use_1",
      requestId: "request_1",
    });
  return { ask, options, decide };
}

function model(value: string, resolvedModel?: string): ModelInfo {
  return {
    value,
    resolvedModel,
    displayName: `Native ${value}`,
    description: "",
  };
}

describe("claudeCode.createModelProvider", () => {
  it("fixes binding policy at construction without I/O", async () => {
    const binding = await createBinding();
    expect(binding.id).toBe(CLAUDE_CODE);
    expect(createClaudeCodeProvider).not.toHaveBeenCalled();
    void binding.sdk;
    expect(createClaudeCodeProvider).toHaveBeenCalledWith({
      executable: "/test/claude",
      env: {
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    });
    expect(binding.sdk.languageModel("sonnet")).toMatchObject({
      modelId: "sonnet",
    });
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("checks installation before login and maps a logged-out CLI to authentication_required", async () => {
    native.installed.mockReturnValueOnce(false);
    discoverModels.mockResolvedValueOnce(undefined);
    const binding = await createBinding();
    await expect(binding.discover()).resolves.toEqual({
      status: "not_installed",
    });
    expect(discoverModels).not.toHaveBeenCalled();
    await expect(binding.discover()).resolves.toEqual({
      status: "authentication_required",
      login: { executable: "/test/claude", args: ["auth", "login"] },
    });
    expect(catalog.get).not.toHaveBeenCalled();
    await expect(binding.discover()).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("keeps native IDs, drops the default alias, enriches by resolved model, and orders by tier", async () => {
    const metadata = ModelsDev.Model.parse({
      id: "claude-sonnet-5",
      name: "Sonnet",
      release_date: "2026-01-01",
      attachment: true,
      reasoning: false,
      tool_call: true,
      temperature: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 200_000, output: 64_000 },
      cost: { input: 3, output: 15 },
    });
    catalog.get.mockResolvedValue({
      anthropic: { models: { "claude-sonnet-5": metadata } },
    });
    discoverModels.mockResolvedValue([
      model("default", "claude-sonnet-5"),
      model("haiku"),
      {
        ...model("sonnet", "claude-sonnet-5"),
        supportedEffortLevels: ["low", "high"],
      },
      model("opus"),
      model("future-model"),
    ]);
    const available = ready(await (await createBinding()).discover());
    expect(available.models.map(({ id, tier }) => [id, tier])).toEqual([
      ["opus", 3],
      ["sonnet", 2],
      ["haiku", 1],
      ["future-model", undefined],
    ]);
    expect(available.models[1]).toMatchObject({
      id: "sonnet",
      aliases: ["claude-sonnet-5"],
      availableVariants: ["low", "high"],
      capabilities: { reasoning: true, attachment: true },
      limit: metadata.limit,
    });
    expect(AvailableProvider.safeParse(available).success).toBe(true);
  });

  it.each(["sonnet", "claude-sonnet-5-5"])(
    "keeps the versioned native name and recognizes %s as Sonnet tier 2",
    async (value) => {
      discoverModels.mockResolvedValue([
        {
          ...model(value, "claude-sonnet-5-5"),
          displayName: "Sonnet 5.5",
          description: "Most efficient for simpler tasks",
        },
      ]);
      const available = ready(await (await createBinding()).discover());
      expect(available.models).toMatchObject([
        {
          id: value,
          aliases: ["claude-sonnet-5-5"],
          name: "Sonnet 5.5",
          description: "Most efficient for simpler tasks",
          tier: 2,
        },
      ]);
    },
  );

  it("rejects duplicate native IDs and propagates discovery failures", async () => {
    discoverModels.mockResolvedValueOnce([model("same"), model("same")]);
    const binding = await createBinding();
    await expect(binding.discover()).rejects.toThrow(
      "Duplicate Claude SDK model ID",
    );
    const failure = new Error("cli exploded");
    discoverModels.mockRejectedValueOnce(failure);
    await expect(binding.discover()).rejects.toBe(failure);
  });

  it("disposes once and refuses further use", async () => {
    const binding = await createBinding();
    void binding.sdk;
    await Promise.all([binding.dispose(), binding.dispose()]);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(binding.discover()).rejects.toThrow("disposed");
  });
});

describe("readQuota", () => {
  const window = (utilization: number | null, resets_at: string | null) => ({
    utilization,
    resets_at,
  });

  it("translates plan windows, named model buckets, and enabled extra usage", async () => {
    readUsage.mockResolvedValue({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: window(4, "2026-09-25T04:40:00.333786+00:00"),
        seven_day: window(null, "2026-09-27T15:00:00.333809+00:00"),
        seven_day_opus: window(50, null),
        model_scoped: [
          { display_name: "Fable", utilization: 38, resets_at: null },
        ],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 20000,
          used_credits: 1250,
          utilization: 6,
          currency: "USD",
          decimal_places: 2,
        } as never,
      },
    });
    await expect((await createBinding()).readQuota()).resolves.toEqual({
      status: "ready",
      plan: "max",
      meters: [
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 300 },
          usage: { kind: "percent", usedPercent: 4 },
          resetsAt: "2026-09-25T04:40:00.333Z",
        },
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 10080 },
          resetsAt: "2026-09-27T15:00:00.333Z",
        },
        {
          scope: { kind: "model", name: "Fable" },
          window: { kind: "duration", minutes: 10080 },
          usage: { kind: "percent", usedPercent: 38 },
        },
        {
          scope: { kind: "account" },
          window: { kind: "month" },
          usage: { kind: "spend", used: 12.5, limit: 200, currency: "USD" },
        },
      ],
    });
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("falls back to fixed model buckets and percent extra usage, and drops disabled extra usage", async () => {
    const binding = await createBinding();
    readUsage.mockResolvedValueOnce({
      subscription_type: null,
      rate_limits_available: true,
      rate_limits: {
        seven_day_sonnet: window(70, null),
        extra_usage: {
          is_enabled: true,
          monthly_limit: 20000,
          used_credits: 0,
          utilization: 0,
          currency: "USD",
        },
      },
    });
    await expect(binding.readQuota()).resolves.toEqual({
      status: "ready",
      meters: [
        {
          scope: { kind: "model", name: "Sonnet" },
          window: { kind: "duration", minutes: 10080 },
          usage: { kind: "percent", usedPercent: 70 },
        },
        {
          scope: { kind: "account" },
          window: { kind: "month" },
          usage: { kind: "percent", usedPercent: 0 },
        },
      ],
    });
    readUsage.mockResolvedValueOnce({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: window(1, null),
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      },
    });
    await expect(binding.readQuota()).resolves.toEqual({
      status: "ready",
      plan: "pro",
      meters: [
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 300 },
          usage: { kind: "percent", usedPercent: 1 },
        },
      ],
    });
  });

  it("reports no plan for API-key sessions and rejects logged-out or missing CLIs", async () => {
    const binding = await createBinding();
    await expect(binding.readQuota()).resolves.toEqual({
      status: "not_applicable",
    });
    readUsage.mockResolvedValueOnce(undefined);
    await expect(binding.readQuota()).rejects.toThrow("not logged in");
    native.installed.mockReturnValueOnce(false);
    await expect(binding.readQuota()).rejects.toThrow("executable not found");
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("passes cwd and tools through and pre-approves OpenChart's own tools", async () => {
    const { options, decide, ask } = await policy();
    expect(options.cwd).toBe("/workspace");
    expect(options.tools).toEqual({});
    await expect(
      decide("mcp__openchart__resource_read", { path: "/" }),
    ).resolves.toMatchObject({
      behavior: "allow",
      toolUseID: "use_1",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("maps native tools onto OpenChart permissions and denies on refusal", async () => {
    const { decide, ask } = await policy();
    await expect(decide("Bash", { command: "pwd" })).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permission: "run_command",
        patterns: ["pwd"],
        always: ["pwd"],
      }),
    );
    await expect(
      decide("Edit", { file_path: "/notes.md" }),
    ).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({ permission: "edit", patterns: ["/notes.md"] }),
    );
    ask.mockRejectedValueOnce(new Error("Not allowed"));
    await expect(decide("WebFetch", { url: "https://x" })).resolves.toEqual({
      behavior: "deny",
      message: "Not allowed",
      toolUseID: "use_1",
      decisionClassification: "user_reject",
    });
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permission: "webfetch",
        patterns: ["https://x"],
      }),
    );
  });

  it.each([
    ["ask", "default", false, true],
    ["auto", "auto", false, true],
    ["full-access", "bypassPermissions", true, false],
  ] as const)(
    "maps %s to native permission and sandbox settings",
    async (mode, permissionMode, allowDangerouslySkipPermissions, enabled) => {
      const { options } = await policy(undefined, mode);
      expect(options).toMatchObject({
        permissionMode,
        allowDangerouslySkipPermissions,
        sandbox: { enabled },
      });
      if (enabled)
        expect(options.sandbox).toMatchObject({
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
        });
    },
  );

  it("never asks the host in full access, even when the CLI invokes canUseTool", async () => {
    const ask = vi.fn(async () => {
      throw new Error("Must not ask");
    });
    const { decide } = await policy(ask, "full-access");
    for (const [name, input] of [
      ["Bash", { command: "touch /outside/file" }],
      ["Write", { file_path: "/outside/file" }],
      ["WebFetch", { url: "http://127.0.0.1/test" }],
      ["mcp__openchart__resource_read", { path: "/" }],
    ] as const) {
      await expect(decide(name, input)).resolves.toMatchObject({
        behavior: "allow",
        updatedInput: input,
      });
    }
    expect(ask).not.toHaveBeenCalled();
  });
});

it.each(["ask", "auto", "full-access"] as const)(
  "collects Claude single, multiple and text answers in %s mode",
  async (permissionMode) => {
    const { claudeCode } = await import("./binding");
    const askPermission = vi.fn(async () => {});
    const askQuestion = vi.fn(async () => ({
      type: "answered" as const,
      answers: {
        "0": ["Fast"],
        "1": ["Charts", "Tables"],
        "2": ["My own answer"],
      },
    }));
    const options = claudeCode.requestOptions({
      cwd: "/workspace",
      tools: {},
      permissionMode,
      askPermission,
      askQuestion,
    });
    const questions = ["Which mode?", "Which outputs?", "Any preference?"].map(
      (question, index) => ({
        question,
        header: String(index),
        multiSelect: index === 1,
        options: [{ label: "Fast", description: "Quick result" }],
      }),
    );
    const context = {
      signal: new AbortController().signal,
      toolUseID: "tool",
      requestId: "request",
    };
    await expect(
      options.canUseTool!("AskUserQuestion", { questions }, context),
    ).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: {
        questions,
        answers: {
          "Which mode?": "Fast",
          "Which outputs?": "Charts, Tables",
          "Any preference?": "My own answer",
        },
      },
    });
    expect(askQuestion).toHaveBeenCalledWith(
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
      { signal: context.signal },
    );
    expect(askPermission).not.toHaveBeenCalled();
  },
);

it("returns an explicit skipped result to Claude without granting permission", async () => {
  const { claudeCode } = await import("./binding");
  const options = claudeCode.requestOptions({
    cwd: "/workspace",
    tools: {},
    permissionMode: "full-access",
    askPermission: vi.fn(),
    askQuestion: async () => ({ type: "skipped" }),
  });
  await expect(
    options.canUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Choose",
            header: "Mode",
            options: [],
            multiSelect: false,
          },
        ],
      },
      {
        signal: new AbortController().signal,
        toolUseID: "tool",
        requestId: "request",
      },
    ),
  ).resolves.toMatchObject({
    behavior: "deny",
    message: expect.stringContaining("skipped"),
  });
});

describe("transcript normalization", () => {
  it("renames tool IDs the SDK rejects without touching the caller's messages", async () => {
    const { claudeCode } = await import("./binding");
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call.bad",
            toolName: "search",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call.bad",
            toolName: "search",
            output: { type: "text", value: "" },
          },
        ],
      },
    ] as ModelMessage[];
    const result = claudeCode.normalizeMessages(messages);
    expect(result[0]!.content[0]).toMatchObject({ toolCallId: "call_bad" });
    expect(result[1]!.content[0]).toMatchObject({ toolCallId: "call_bad" });
    expect(messages[0]!.content[0]).toMatchObject({ toolCallId: "call.bad" });
  });
});
