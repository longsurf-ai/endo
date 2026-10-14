// Purpose: Owner tests for the Codex model provider construction policy, discovery, and request policy.
import { CODEX } from "@openchart/models/model-tiers";
import type { ProviderPermissionMode } from "@openchart/models/provider-permission";
// Module:  @openchart/models

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelsDev } from "@openchart/models/catalog";
import {
  AvailableProvider,
  type AvailableModel,
  type ModelProvider,
  type ProviderDiscoveryResult,
} from "@openchart/models/model-provider";
import type {
  AccountRateLimitsReadResponse,
  AccountReadResponse,
  CodexModel,
  ServerRequest,
} from "@openchart/models/providers/codex/adapter/index";

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
const readAccount = vi.fn<() => Promise<AccountReadResponse>>();
const readRateLimits = vi.fn<() => Promise<AccountRateLimitsReadResponse>>();
const listModels =
  vi.fn<() => Promise<{ models: CodexModel[]; nextCursor: string | null }>>();
const catalog = {
  get: vi.fn<() => Promise<Record<string, ModelsDev.Provider>>>(),
};
const bindings: ModelProvider[] = [];
const createCodexProvider = vi.fn((settings: Record<string, unknown>) => ({
  languageModel: (modelId: string) => ({ modelId, settings }),
  dispose,
  readAccount,
  readRateLimits,
  listModels,
}));

vi.doMock("@openchart/models/providers/codex/adapter/index", () => ({
  CODEX_PROVIDER: "codex-app-server",
  createCodexProvider,
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.installed.mockReset().mockReturnValue(true);
  readAccount.mockReset().mockResolvedValue({
    account: { type: "chatgpt" },
    requiresOpenaiAuth: true,
  });
  readRateLimits.mockReset().mockResolvedValue({ rateLimits: {} });
  listModels.mockReset().mockResolvedValue({ models: [], nextCursor: null });
  catalog.get.mockReset().mockResolvedValue({});
});

afterEach(async () => {
  await Promise.all(bindings.splice(0).map((binding) => binding.dispose()));
});

async function createBinding() {
  const { codex } = await import("./binding");
  const binding = codex.createModelProvider(catalog, "/test/codex");
  bindings.push(binding);
  return binding;
}

async function requestPolicy(
  ask = vi.fn(async () => {}),
  permissionMode: ProviderPermissionMode = "ask",
) {
  const { codex } = await import("./binding");
  const options = codex.requestOptions({
    cwd: "/workspace",
    tools: {},
    permissionMode,
    askPermission: ask,
  });
  return {
    ask,
    options,
    decide: (request: ServerRequest) =>
      options.requests!(request, { signal: new AbortController().signal }),
  };
}

function nativeModel(model: string): CodexModel {
  return { model, displayName: `Native ${model}` };
}

describe("codex.createModelProvider", () => {
  it("fixes delegation policy at construction without I/O", async () => {
    const provider = await createBinding();

    expect(provider.id).toBe(CODEX);
    expect(createCodexProvider).not.toHaveBeenCalled();
    void provider.sdk;
    expect(createCodexProvider).toHaveBeenCalledTimes(1);
    expect(createCodexProvider).toHaveBeenCalledWith({
      executable: "/test/codex",
      config: {
        "agents.max_depth": 4,
        "features.default_mode_request_user_input": true,
        check_for_update_on_startup: false,
      },
    });
    expect(provider.sdk.languageModel("gpt-5.6-sol")).toMatchObject({
      modelId: "gpt-5.6-sol",
    });
    expect(readAccount).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("passes cwd and OpenChart tools through unchanged", async () => {
    const { codex } = await import("./binding");
    const tools = {
      resource_search: {
        description: "Search resources",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({}),
        toModelOutput: (output: unknown) => output,
      },
    };
    const options = codex.requestOptions({
      cwd: "/workspace",
      tools,
      permissionMode: "ask",
      askPermission: vi.fn(async () => {}),
    });
    expect(options.cwd).toBe("/workspace");
    expect(options.tools).toBe(tools);
  });

  it("bridges command and file approvals to one permission callback", async () => {
    const { ask, decide } = await requestPolicy();
    const scoped = { threadId: "thread_1", turnId: "turn_1", itemId: "call_1" };

    await expect(
      decide({
        method: "item/commandExecution/requestApproval",
        params: { ...scoped, command: "bun test" },
      }),
    ).resolves.toEqual({ decision: "accept" });
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permission: "run_command",
        patterns: ["bun test"],
      }),
    );

    ask.mockRejectedValueOnce(new Error("denied"));
    await expect(
      decide({
        method: "item/fileChange/requestApproval",
        params: { ...scoped, grantRoot: "/workspace" },
      }),
    ).resolves.toEqual({ decision: "decline" });
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({ permission: "edit", patterns: ["/workspace"] }),
    );
  });

  it.each([
    ["ask", "on-request", "workspace-write", "user"],
    ["auto", "on-request", "workspace-write", "auto_review"],
    ["full-access", "never", "danger-full-access", "user"],
  ] as const)(
    "maps %s to native approval, sandbox, and reviewer policy",
    async (mode, approvalPolicy, sandbox, approvalsReviewer) => {
      const { options } = await requestPolicy(undefined, mode);
      expect(options).toMatchObject({
        approvalPolicy,
        sandbox,
        approvalsReviewer,
      });
    },
  );

  it("never asks the host in full access, including native MCP approval fallbacks", async () => {
    const ask = vi.fn(async () => {
      throw new Error("Must not ask");
    });
    const { decide } = await requestPolicy(ask, "full-access");
    const scoped = { threadId: "thread_1", turnId: "turn_1", itemId: "call_1" };
    await expect(
      decide({
        method: "item/commandExecution/requestApproval",
        params: { ...scoped, command: "touch /outside/file" },
      }),
    ).resolves.toEqual({ decision: "accept" });
    await expect(
      decide({
        method: "item/fileChange/requestApproval",
        params: { ...scoped, grantRoot: "/outside" },
      }),
    ).resolves.toEqual({ decision: "accept" });
    const permissions = {
      network: { enabled: true },
      fileSystem: { write: ["/outside"] },
    };
    await expect(
      decide({
        method: "item/permissions/requestApproval",
        params: { ...scoped, cwd: "/workspace", permissions },
      }),
    ).resolves.toEqual({ permissions, scope: "turn" });
    await expect(
      decide({
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread_1",
          serverName: "native",
          request: { _meta: { codex_approval_kind: "mcp_tool_call" } },
        },
      }),
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(ask).not.toHaveBeenCalled();
  });

  it("grants no additional native permissions when the host refuses", async () => {
    const { decide } = await requestPolicy(
      vi.fn(async () => {
        throw new Error("Denied");
      }),
    );
    await expect(
      decide({
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "call_1",
          cwd: "/workspace",
          permissions: { network: { enabled: true } },
        },
      }),
    ).resolves.toEqual({ permissions: {}, scope: "turn" });
  });

  it("asks only for MCP tool-call elicitations, in either wire shape", async () => {
    const { ask, decide } = await requestPolicy();
    const nested: ServerRequest = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread_1",
        serverName: "browser",
        request: {
          message: "Allow browser.click?",
          _meta: { codex_approval_kind: "mcp_tool_call" },
        },
      },
    };
    await expect(decide(nested)).resolves.toEqual({
      action: "accept",
      content: {},
    });
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permission: "mcp_tool",
        patterns: ["Allow browser.click?"],
      }),
    );

    await expect(
      decide({
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread_1",
          serverName: "browser",
          message: "Allow browser.click?",
          _meta: { codex_approval_kind: "mcp_tool_call" },
        },
      }),
    ).resolves.toEqual({ action: "accept", content: {} });

    await expect(
      decide({
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread_1",
          serverName: "browser",
          request: { message: "Pick one" },
        },
      }),
    ).resolves.toEqual({ action: "decline", content: null });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("returns no answers when the host has no question handler", async () => {
    const { decide } = await requestPolicy();
    await expect(
      decide({
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "call_1",
          isBlocking: true,
          questions: [],
        },
      }),
    ).resolves.toEqual({ answers: {} });
  });

  it("owns separate instances and disposes each exactly once", async () => {
    const first = await createBinding();
    const second = await createBinding();
    const firstSDK = first.sdk;
    const secondSDK = second.sdk;
    await Promise.all([first.dispose(), first.dispose()]);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(createCodexProvider).toHaveBeenCalledTimes(2);
    expect(secondSDK).not.toBe(firstSDK);
    await expect(first.discover()).rejects.toThrow("disposed");
    await expect(second.discover()).resolves.toMatchObject({
      status: "ready",
      provider: { id: CODEX },
    });
  });

  it("pages native models, uses SDK slugs, and groups only mapped IDs by tier", async () => {
    listModels
      .mockResolvedValueOnce({
        models: ["future-model", "gpt-5.6-luna", "gpt-6-astra"].map(
          nativeModel,
        ),
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        models: ["gpt-5.6-sol", "another-new-model", "gpt-5.6-terra"].map(
          nativeModel,
        ),
        nextCursor: null,
      });
    const binding = await createBinding();
    const available = ready(await binding.discover());
    expect(listModels.mock.calls).toEqual([
      [{ includeHidden: true, cursor: undefined }],
      [{ includeHidden: true, cursor: "page2" }],
    ]);
    expect(available.models.map(({ id, tier }) => [id, tier])).toEqual([
      ["gpt-6-astra", 4],
      ["gpt-5.6-sol", 3],
      ["gpt-5.6-terra", 2],
      ["gpt-5.6-luna", 1],
      ["future-model", undefined],
      ["another-new-model", undefined],
    ]);
    expect(AvailableProvider.safeParse(available).success).toBe(true);
  });

  it("enriches exact native IDs without replacing identity or variants or adding catalog models", async () => {
    const metadata = ModelsDev.Model.parse({
      id: "gpt-5.6-sol",
      name: "Catalog name",
      release_date: "2026-01-01",
      attachment: true,
      reasoning: false,
      tool_call: true,
      temperature: false,
      modalities: { input: ["text", "image", "audio"], output: ["text"] },
      limit: { context: 100_000, output: 30_000 },
      cost: {
        input: 1,
        output: 6,
        tiers: [
          { input: 2, output: 9, tier: { type: "context", size: 272_000 } },
        ],
      },
      variants: { invented: { reasoningEffort: "invented" } },
      headers: { secret: "must not escape" },
    });
    catalog.get.mockResolvedValue({
      openai: { models: { "gpt-5.6-sol": metadata, "catalog-only": metadata } },
    });
    listModels.mockResolvedValue({
      models: [
        {
          ...nativeModel("gpt-5.6-sol"),
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "future-effort" },
          ],
        },
      ],
      nextCursor: null,
    });
    const available = ready(await (await createBinding()).discover());
    expect(available.models).toHaveLength(1);
    const model = available.models[0]!;
    expect(model).toMatchObject({
      id: "gpt-5.6-sol",
      name: "Native gpt-5.6-sol",
      providerID: CODEX,
      availableVariants: ["high", "future-effort"],
      capabilities: {
        reasoning: true,
        attachment: true,
        input: { audio: false, image: true },
        output: { text: true },
      },
      limit: metadata.limit,
      cost: {
        input: 1,
        output: 6,
        contextTiers: [{ threshold: 272_000, input: 2, output: 9 }],
      },
    });
    expect(model.cost?.cache.read).toBeUndefined();
    expect(model).not.toHaveProperty("headers");
    expect(AvailableProvider.safeParse(available).success).toBe(true);
  });

  it("preserves unknown metadata and distinguishes missing efforts from an empty set", async () => {
    listModels.mockResolvedValue({
      models: [
        nativeModel("unknown"),
        {
          ...nativeModel("no-effort"),
          supportedReasoningEfforts: [],
          inputModalities: ["text"],
        },
      ],
      nextCursor: null,
    });
    const available = ready(await (await createBinding()).discover());
    const [unknown, none] = available.models;
    expect(unknown).toMatchObject({ capabilities: { input: {}, output: {} } });
    expect(unknown!.capabilities.reasoning).toBeUndefined();
    expect(unknown!.cost).toBeUndefined();
    expect(unknown!.limit).toBeUndefined();
    expect(unknown!.availableVariants).toBeUndefined();
    expect(none).toMatchObject({
      availableVariants: [],
      capabilities: { reasoning: false, attachment: false },
    });
    expect(AvailableProvider.safeParse(available).success).toBe(true);
  });

  it("checks installation before authentication and retries after login", async () => {
    native.installed.mockReturnValueOnce(false);
    readAccount.mockResolvedValueOnce({
      account: null,
      requiresOpenaiAuth: true,
    });
    const binding = await createBinding();
    await expect(binding.discover()).resolves.toMatchObject({
      status: "not_installed",
    });
    expect(readAccount).not.toHaveBeenCalled();
    await expect(binding.discover()).resolves.toEqual({
      status: "authentication_required",
      login: { executable: "/test/codex", args: ["login"] },
    });
    expect(listModels).not.toHaveBeenCalled();
    expect(catalog.get).not.toHaveBeenCalled();
    await expect(binding.discover()).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("allows a native provider that does not require OpenAI authentication", async () => {
    readAccount.mockResolvedValue({ account: null, requiresOpenaiAuth: false });
    await expect((await createBinding()).discover()).resolves.toMatchObject({
      status: "ready",
      provider: { id: CODEX },
    });
  });

  it.each(["account", "models", "catalog"] as const)(
    "propagates %s failures",
    async (stage) => {
      const error = new Error(`${stage} failed`);
      if (stage === "account") readAccount.mockRejectedValue(error);
      if (stage === "models") listModels.mockRejectedValue(error);
      if (stage === "catalog") catalog.get.mockRejectedValue(error);
      await expect((await createBinding()).discover()).rejects.toBe(error);
    },
  );

  it("rejects repeated pagination cursors and duplicate SDK IDs", async () => {
    listModels.mockResolvedValue({ models: [], nextCursor: "again" });
    const binding = await createBinding();
    await expect(binding.discover()).rejects.toThrow(
      "Repeated Codex model cursor",
    );
    listModels.mockResolvedValue({
      models: [nativeModel("same"), nativeModel("same")],
      nextCursor: null,
    });
    await expect(binding.discover()).rejects.toThrow(
      "Duplicate Codex SDK model ID",
    );
  });

  it("does not publish discovery that completes after disposal", async () => {
    let finish!: (catalog: Record<string, ModelsDev.Provider>) => void;
    catalog.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const binding = await createBinding();
    const discovery = binding.discover();
    await vi.waitFor(() => expect(catalog.get).toHaveBeenCalledOnce());
    await binding.dispose();
    finish({});
    await expect(discovery).rejects.toThrow("disposed");
  });
});

describe("readQuota", () => {
  it("translates every bucket window into meters without discovery", async () => {
    const weekly = { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1 };
    readRateLimits.mockResolvedValue({
      ordinaryUsageAllowed: false,
      rateLimits: { planType: "pro", primary: weekly },
      rateLimitsByLimitId: {
        codex: {
          planType: "pro",
          primary: weekly,
          secondary: { usedPercent: 12, windowDurationMins: 300 },
        },
        "gpt-5.6-luna": {
          limitName: "Luna",
          normalModelSlug: "gpt-5.6-luna",
          primary: { usedPercent: 40, windowDurationMins: null },
        },
      },
    });
    await expect((await createBinding()).readQuota()).resolves.toEqual({
      status: "ready",
      plan: "pro",
      blocked: true,
      meters: [
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 10080 },
          usage: { kind: "percent", usedPercent: 99 },
          resetsAt: "1970-01-01T00:00:01.000Z",
        },
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 300 },
          usage: { kind: "percent", usedPercent: 12 },
        },
        {
          scope: { kind: "model", name: "Luna" },
          usage: { kind: "percent", usedPercent: 40 },
        },
      ],
    });
    expect(listModels).not.toHaveBeenCalled();
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("falls back to the single bucket and omits what the backend leaves unknown", async () => {
    readRateLimits.mockResolvedValue({
      rateLimits: { planType: "unknown", primary: { usedPercent: 0 } },
    });
    await expect((await createBinding()).readQuota()).resolves.toEqual({
      status: "ready",
      meters: [
        {
          scope: { kind: "account" },
          usage: { kind: "percent", usedPercent: 0 },
        },
      ],
    });
  });

  it("reports no plan for API keys and custom providers, and rejects missing setup", async () => {
    const binding = await createBinding();
    readAccount.mockResolvedValueOnce({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
    });
    await expect(binding.readQuota()).resolves.toEqual({
      status: "not_applicable",
    });
    readAccount.mockResolvedValueOnce({
      account: null,
      requiresOpenaiAuth: false,
    });
    await expect(binding.readQuota()).resolves.toEqual({
      status: "not_applicable",
    });
    readAccount.mockResolvedValueOnce({
      account: null,
      requiresOpenaiAuth: true,
    });
    await expect(binding.readQuota()).rejects.toThrow("not logged in");
    expect(readRateLimits).not.toHaveBeenCalled();
    native.installed.mockReturnValueOnce(false);
    await expect(binding.readQuota()).rejects.toThrow("executable not found");
  });
});

it.each(["ask", "auto", "full-access"] as const)(
  "collects Codex answers in %s mode without permission grants",
  async (permissionMode) => {
    const { codex } = await import("./binding");
    const askPermission = vi.fn(async () => {});
    const askQuestion = vi.fn(async () => ({
      type: "answered" as const,
      answers: { mode: ["Custom"] },
    }));
    const options = codex.requestOptions({
      cwd: "/workspace",
      tools: {},
      permissionMode,
      askPermission,
      askQuestion,
    });
    const signal = new AbortController().signal;
    const result = await options.requests!(
      {
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          isBlocking: false,
          questions: [
            {
              id: "mode",
              header: "Mode",
              question: "Which mode?",
              isOther: true,
              isSecret: false,
              options: [{ label: "Fast", description: "Quick result" }],
            },
          ],
        },
      },
      { signal },
    );
    expect(result).toEqual({ answers: { mode: { answers: ["Custom"] } } });
    expect(askQuestion).toHaveBeenCalledWith(
      {
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Which mode?",
            multiple: false,
            allowFreeform: true,
            secret: false,
            options: [{ label: "Fast", description: "Quick result" }],
          },
        ],
      },
      { signal },
    );
    expect(askPermission).not.toHaveBeenCalled();
  },
);

describe("native defaults", () => {
  it("defaults GPT-5 models to medium effort and leaves other models alone", async () => {
    const { codex } = await import("./binding");
    const model = (id: string): AvailableModel => ({
      id,
      providerID: CODEX,
      kind: "language",
      name: id,
      capabilities: { input: {}, output: {} },
    });
    expect(codex.defaultOptions(model("gpt-5.6-luna"))).toEqual({
      effort: "medium",
    });
    expect(codex.defaultOptions(model("gpt-6-astra"))).toEqual({});
  });
});
