// Purpose: Owner tests for the Grok binding's construction policy, discovery, quota, sign-in, and request policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsDev } from "@openchart/models/catalog";
import {
  GROK,
  TIER1,
  TIER4,
  resolveModelTier,
} from "@openchart/models/model-tiers";
import {
  AvailableProvider,
  type ModelProvider,
  type ProviderDiscoveryResult,
} from "@openchart/models/model-provider";

const native = vi.hoisted(() => ({ installed: vi.fn() }));
vi.mock("@openchart/models/providers/executable", () => ({
  hasExecutable: native.installed,
}));

const dispose = vi.fn(async () => {});
const discoverModels = vi.fn<() => Promise<unknown[] | undefined>>();
const readUsage = vi.fn<() => Promise<unknown>>();
const catalog = {
  get: vi.fn<() => Promise<Record<string, ModelsDev.Provider>>>(),
};
const createGrokProvider = vi.fn((settings: Record<string, unknown>) => ({
  languageModel: (modelId: string) => ({ modelId, settings }),
  dispose,
  discoverModels,
  readUsage,
}));
vi.doMock("@openchart/models/providers/grok/adapter/index", () => ({
  GROK_PROVIDER: "grok",
  createGrokProvider,
}));

const bindings: ModelProvider[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  native.installed.mockReset().mockReturnValue(true);
  discoverModels.mockReset().mockResolvedValue([]);
  readUsage.mockReset();
  catalog.get.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  await Promise.all(bindings.splice(0).map((binding) => binding.dispose()));
});

async function createBinding() {
  const { grok } = await import("./binding");
  const binding = grok.createModelProvider(catalog, "/test/grok");
  bindings.push(binding);
  return binding;
}

function ready(result: ProviderDiscoveryResult) {
  if (result.status !== "ready")
    throw new Error(`Expected ready, got ${result.status}`);
  return result.provider;
}

const efforts = (...values: string[]) =>
  values.map((value) => ({ id: value, value, default: value === "high" }));
const MODELS = [
  {
    modelId: "grok-4.7",
    name: "Grok 4.7",
    description: "SpaceXAI's latest frontier model",
    _meta: {
      totalContextTokens: 256000,
      supportsReasoningEffort: true,
      reasoningEfforts: efforts("xhigh", "high", "medium", "low"),
    },
  },
  {
    modelId: "grok-4.7-build-fast",
    name: "Grok 4.7 Fast",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: efforts("xhigh", "high", "medium", "low"),
    },
  },
  {
    modelId: "grok-4.5",
    name: "Grok 4.5",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: efforts("high", "medium", "low"),
    },
  },
  { modelId: "grok-4.6", name: "Grok 4.6" },
];

describe("grok.createModelProvider", () => {
  it("fixes binding policy at construction without I/O", async () => {
    const binding = await createBinding();
    expect(binding.id).toBe(GROK);
    expect(createGrokProvider).not.toHaveBeenCalled();
    void binding.sdk;
    expect(createGrokProvider).toHaveBeenCalledWith({
      executable: "/test/grok",
      env: expect.objectContaining({
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_CLAUDE_MCPS_ENABLED: "0",
        GROK_CLAUDE_SKILLS_ENABLED: "0",
        GROK_CLAUDE_HOOKS_ENABLED: "0",
        GROK_CURSOR_RULES_ENABLED: "0",
      }),
    });
  });

  it("checks installation first and signs in with a device code", async () => {
    native.installed.mockReturnValue(false);
    const binding = await createBinding();
    expect(await binding.discover()).toEqual({ status: "not_installed" });
    expect(discoverModels).not.toHaveBeenCalled();

    native.installed.mockReturnValue(true);
    discoverModels.mockResolvedValue(undefined);
    expect(await binding.discover()).toEqual({
      status: "authentication_required",
      login: { executable: "/test/grok", args: ["login", "--device-auth"] },
    });
  });

  it("projects efforts into variants, enriches exact xAI catalog IDs, and orders by tier", async () => {
    discoverModels.mockResolvedValue(MODELS);
    catalog.get.mockResolvedValue({
      xai: {
        models: {
          "grok-4.7": {
            id: "grok-4.7",
            name: "Grok 4.7",
            reasoning: true,
            tool_call: true,
            cost: { input: 3, output: 15, cache_read: 0.75 },
            limit: { context: 256000, output: 64000 },
          },
        },
      },
    } as never);
    const binding = await createBinding();
    const provider = AvailableProvider.parse(ready(await binding.discover()));
    expect(provider.name).toBe("Grok");
    expect(provider.models.map((model) => [model.id, model.tier])).toEqual([
      ["grok-4.7", 3],
      ["grok-4.6", 2],
      ["grok-4.5", 1],
      ["grok-4.7-build-fast", undefined],
    ]);
    const frontier = provider.models[0]!;
    expect(frontier).toMatchObject({
      providerID: GROK,
      description: "SpaceXAI's latest frontier model",
      availableVariants: ["low", "medium", "high", "xhigh"],
      capabilities: {
        reasoning: true,
        toolcall: true,
        attachment: false,
        input: { text: true, image: false },
      },
      cost: { input: 3, output: 15, cache: { read: 0.75 } },
      limit: { context: 256000, output: 64000 },
    });
    // Unknown native efforts stay unknown rather than becoming no variants.
    expect(
      provider.models.find((model) => model.id === "grok-4.6")
        ?.availableVariants,
    ).toBeUndefined();
    expect(resolveModelTier(GROK, TIER4, provider.models)?.id).toBe("grok-4.7");
    expect(resolveModelTier(GROK, TIER1, provider.models)?.id).toBe("grok-4.5");
  });

  it("propagates discovery failures and refuses use after disposal", async () => {
    discoverModels.mockRejectedValue(new Error("agent crashed"));
    const binding = await createBinding();
    await expect(binding.discover()).rejects.toThrow("agent crashed");
    await binding.dispose();
    await expect(binding.discover()).rejects.toThrow("disposed");
    expect(() => binding.sdk).toThrow("disposed");
  });
});

describe("readQuota", () => {
  it("reports the plan's credit period as one account meter", async () => {
    readUsage.mockResolvedValue({
      subscription: {
        authenticated: true,
        meta: { auth_mode: "Oidc", subscription_tier: "SuperGrok" },
      },
      billing: {
        config: {
          creditUsagePercent: 12.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-10-16T00:13:45.742+00:00",
            end: "2026-10-23T00:13:45.742+00:00",
          },
        },
        subscription_tier: "SuperGrok",
      },
    });
    const binding = await createBinding();
    expect(await binding.readQuota()).toEqual({
      status: "ready",
      meters: [
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 7 * 24 * 60 },
          usage: { kind: "percent", usedPercent: 12.5 },
          resetsAt: "2026-10-23T00:13:45.742Z",
        },
      ],
    });
  });

  it("treats API-key accounts as unmetered", async () => {
    readUsage.mockResolvedValue({
      subscription: { authenticated: true, meta: { auth_mode: "ApiKey" } },
      billing: { config: { creditUsagePercent: 0 } },
    });
    const binding = await createBinding();
    expect(await binding.readQuota()).toEqual({ status: "not_applicable" });
  });

  it("rejects a signed-out or missing CLI", async () => {
    readUsage.mockResolvedValue(undefined);
    const binding = await createBinding();
    await expect(binding.readQuota()).rejects.toThrow("not signed in");
    native.installed.mockReturnValue(false);
    await expect(binding.readQuota()).rejects.toThrow("not found");
  });
});

describe("request policy", () => {
  async function options(
    permissionMode: "ask" | "auto" | "full-access",
    askPermission = vi.fn(async () => {}),
    askQuestion?: Parameters<
      (typeof import("./binding"))["grok"]["requestOptions"]
    >[0]["askQuestion"],
  ) {
    const { grok } = await import("./binding");
    return grok.requestOptions({
      cwd: "/work",
      tools: {},
      permissionMode,
      askPermission,
      ...(askQuestion && { askQuestion }),
    });
  }

  it.each([
    ["ask", "default"],
    ["auto", "auto"],
    ["full-access", "always-approve"],
  ] as const)("maps %s to Grok's %s mode", async (mode, native) => {
    expect(await options(mode)).toMatchObject({
      cwd: "/work",
      tools: {},
      permissionMode: native,
    });
  });

  it.each([
    [
      {
        kind: "execute",
        title: "Run",
        input: { variant: "Bash", command: "ls" },
      },
      "run_command",
      "ls",
    ],
    [
      { kind: "edit", title: "Edit", input: { file_path: "/work/a.ts" } },
      "edit",
      "/work/a.ts",
    ],
    [
      { kind: "fetch", title: "Fetch", input: { url: "https://x.ai" } },
      "web_fetch",
      "https://x.ai",
    ],
    [
      {
        kind: "other",
        title: "MCP",
        input: { tool_name: "github__create_issue" },
      },
      "mcp_tool",
      "github__create_issue",
    ],
  ])("asks the host for %j as %s", async (request, permission, pattern) => {
    const askPermission = vi.fn(async () => {});
    const { approve } = await options("ask", askPermission);
    await expect(approve!(request, new AbortController().signal)).resolves.toBe(
      true,
    );
    expect(askPermission).toHaveBeenCalledWith({
      permission,
      patterns: [pattern],
      metadata: request,
      always: [pattern],
    });
  });

  it("denies when the host refuses", async () => {
    const { approve } = await options(
      "ask",
      vi.fn(async () => {
        throw new Error("denied");
      }),
    );
    await expect(
      approve!(
        { kind: "execute", title: "", input: { command: "rm -rf /" } },
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
  });

  it("answers questions by text and skips when the host skips", async () => {
    const askQuestion = vi
      .fn()
      .mockResolvedValueOnce({ type: "answered", answers: { "0": ["Blue"] } })
      .mockResolvedValueOnce({ type: "skipped" });
    const { answer } = await options("ask", undefined, askQuestion);
    const request = {
      questions: [
        {
          question: "Which color?",
          options: [{ label: "Blue", description: "" }],
          multiSelect: false,
        },
      ],
    };
    const signal = new AbortController().signal;
    await expect(answer!(request, signal)).resolves.toEqual({
      "Which color?": "Blue",
    });
    expect(askQuestion).toHaveBeenCalledWith(
      {
        questions: [
          {
            id: "0",
            header: "",
            question: "Which color?",
            options: [{ label: "Blue", description: "" }],
            multiple: false,
            allowFreeform: true,
            secret: false,
          },
        ],
      },
      { signal },
    );
    await expect(answer!(request, signal)).resolves.toBeUndefined();
    expect(await options("ask")).not.toHaveProperty("answer");
  });
});
