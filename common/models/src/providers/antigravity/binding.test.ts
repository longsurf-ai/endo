// Purpose: Owner tests for the Antigravity binding's construction policy, discovery, quota, sign-in, and request policy.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelsDev } from "@openchart/models/catalog";
import {
  ANTIGRAVITY,
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
const discoverModels =
  vi.fn<() => Promise<Array<{ id: string; name: string }> | undefined>>();
const readUsage = vi.fn<() => Promise<unknown>>();
const catalog = {
  get: vi.fn<() => Promise<Record<string, ModelsDev.Provider>>>(),
};
const createAntigravityProvider = vi.fn(
  (settings: Record<string, unknown>) => ({
    languageModel: (modelId: string) => ({ modelId, settings }),
    dispose,
    discoverModels,
    readUsage,
  }),
);
vi.doMock("@openchart/models/providers/antigravity/adapter/index", () => ({
  ANTIGRAVITY_PROVIDER: "antigravity",
  createAntigravityProvider,
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
  const { antigravity } = await import("./binding");
  const binding = antigravity.createModelProvider(catalog, "/test/antigravity");
  bindings.push(binding);
  return binding;
}

function ready(result: ProviderDiscoveryResult) {
  if (result.status !== "ready")
    throw new Error(`Expected ready, got ${result.status}`);
  return result.provider;
}

const ROWS = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
  ["gemini-experimental", "Gemini Experimental"],
].map(([id, name]) => ({ id: id!, name: name! }));

describe("antigravity.createModelProvider", () => {
  it("fixes binding policy at construction without I/O", async () => {
    const binding = await createBinding();
    expect(createAntigravityProvider).not.toHaveBeenCalled();
    expect(binding.id).toBe(ANTIGRAVITY);
    binding.sdk.languageModel("gemini-3.1-pro");
    expect(createAntigravityProvider).toHaveBeenCalledWith({
      executable: "/test/antigravity",
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    });
  });

  it("checks installation first and signs in through bash", async () => {
    native.installed.mockReturnValue(false);
    const binding = await createBinding();
    expect(await binding.discover()).toEqual({ status: "not_installed" });
    expect(discoverModels).not.toHaveBeenCalled();

    native.installed.mockReturnValue(true);
    discoverModels.mockResolvedValue(undefined);
    const result = await binding.discover();
    expect(result).toMatchObject({
      status: "authentication_required",
      login: {
        executable: "/bin/bash",
        args: [
          "-c",
          expect.any(String),
          "antigravity-sign-in",
          "/test/antigravity",
        ],
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "signs in through script with the host's piped input reaching the CLI",
    async () => {
      // A fake CLI that requires a terminal, as the real one does, and echoes one line.
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-sign-in-"));
      const cli = path.join(directory, "antigravity");
      await writeFile(
        cli,
        `#!${process.execPath}\nif (!process.stdin.isTTY) { console.log("not a terminal"); process.exit(9); }\nconsole.log("args:" + process.argv.slice(2).join(" ") + " update:" + process.env.AGY_CLI_DISABLE_AUTO_UPDATE);\nprocess.stdin.once("data", (code) => { console.log("code:" + code.toString().trim()); process.exit(Number(process.env.FAKE_EXIT)); });\n`,
      );
      await chmod(cli, 0o755);
      native.installed.mockReturnValue(true);
      discoverModels.mockResolvedValue(undefined);
      const { antigravity } = await import("./binding");
      const binding = antigravity.createModelProvider(catalog, cli);
      bindings.push(binding);
      const result = await binding.discover();
      if (result.status !== "authentication_required")
        throw new Error(result.status);
      const { login } = result;
      // Node gives children a socket as stdin, like the host's sign-in job,
      // and keeps it open until the process exits.
      const signIn = async (exit: number) => {
        const child = spawn(login.executable, login.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, FAKE_EXIT: String(exit) },
        });
        let output = "";
        let sent = false;
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (sent || !output.includes("args:")) return;
          sent = true;
          child.stdin.write("4/secret-code\n");
        });
        const code = await new Promise((resolve) => child.on("exit", resolve));
        return { output, code };
      };
      const succeeded = await signIn(0);
      const failed = await signIn(3);
      await rm(directory, { recursive: true, force: true });
      expect(succeeded.output).toContain("args:-p /usage update:true");
      expect(succeeded.output).toContain("code:4/secret-code");
      // The CLI's own status, which Linux `script` alone would misreport.
      expect([succeeded.code, failed.code]).toEqual([0, 3]);
    },
    20_000,
  );

  it("merges effort rows into models, enriches exact catalog IDs, and orders by tier", async () => {
    discoverModels.mockResolvedValue(ROWS);
    catalog.get.mockResolvedValue({
      google: {
        models: {
          "gemini-3.8-flash": ModelsDev.Model.parse({
            id: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
            reasoning: true,
            temperature: true,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            cost: { input: 0.3, output: 2.5, cache_read: 0.03 },
            limit: { context: 1_048_576, output: 65_536 },
          }),
        },
      },
    });
    const provider = ready(await (await createBinding()).discover());
    expect(AvailableProvider.parse(provider)).toEqual(provider);
    expect(provider).toMatchObject({ id: ANTIGRAVITY, name: "Antigravity" });
    expect(
      provider.models.map((model) => [
        model.id,
        model.tier,
        model.availableVariants,
      ]),
    ).toEqual([
      ["claude-opus-5-5", 4, ["low", "medium", "high"]],
      ["claude-sonnet-5-5", 3, ["low"]],
      ["gemini-3.1-pro", 2, ["low", "high"]],
      ["gemini-3.8-flash", 1, ["low", "medium", "high"]],
      ["gpt-oss-120b", undefined, ["medium"]],
      ["gemini-experimental", undefined, []],
    ]);
    const flash = provider.models.find(
      (model) => model.id === "gemini-3.8-flash",
    )!;
    expect(flash).toMatchObject({
      name: "Gemini 3.8 Flash",
      cost: { input: 0.3, output: 2.5, cache: { read: 0.03 } },
      limit: { context: 1_048_576, output: 65_536 },
      capabilities: {
        reasoning: true,
        toolcall: true,
        // Headless input is text only, whatever the catalog says.
        attachment: false,
        input: {
          text: true,
          image: false,
          audio: false,
          video: false,
          pdf: false,
        },
      },
    });
    // No exact catalog match: prices and limits stay unknown.
    expect(
      provider.models.find((model) => model.id === "gemini-3.1-pro")?.cost,
    ).toBeUndefined();
    expect(resolveModelTier(ANTIGRAVITY, TIER4, provider.models)?.id).toBe(
      "claude-opus-5-5",
    );
  });

  it("falls back to Gemini when the plan offers no Claude models", async () => {
    discoverModels.mockResolvedValue(
      ROWS.filter((row) => row.id.startsWith("gemini-3.")),
    );
    const provider = ready(await (await createBinding()).discover());
    expect(resolveModelTier(ANTIGRAVITY, TIER4, provider.models)?.id).toBe(
      "gemini-3.1-pro",
    );
  });

  it("propagates discovery failures and refuses use after disposal", async () => {
    discoverModels.mockRejectedValue(new Error("network down"));
    const binding = await createBinding();
    await expect(binding.discover()).rejects.toThrow("network down");
    await binding.dispose();
    await binding.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(binding.discover()).rejects.toThrow(/disposed/);
  });
});

describe("readQuota", () => {
  it("translates each model group's buckets, shortest window first", async () => {
    readUsage.mockResolvedValue({
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.99,
              reset_time: "2026-10-10T21:17:49Z",
            },
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.75,
              reset_time: "2026-10-04T02:17:49.000+00:00",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [{ id: "3p-daily", window: "daily", remaining_fraction: 1 }],
        },
      ],
    });
    expect(await (await createBinding()).readQuota()).toEqual({
      status: "ready",
      meters: [
        {
          scope: { kind: "model", name: "Gemini Models" },
          window: { kind: "duration", minutes: 300 },
          usage: { kind: "percent", usedPercent: 25 },
          resetsAt: "2026-10-04T02:17:49.000Z",
        },
        {
          scope: { kind: "model", name: "Gemini Models" },
          window: { kind: "duration", minutes: 10_080 },
          usage: { kind: "percent", usedPercent: expect.closeTo(1, 5) },
          resetsAt: "2026-10-10T21:17:49.000Z",
        },
        {
          scope: { kind: "model", name: "Claude and GPT models" },
          usage: { kind: "percent", usedPercent: 0 },
        },
      ],
    });
  });

  it("rejects a signed-out or missing CLI", async () => {
    readUsage.mockResolvedValue(undefined);
    await expect((await createBinding()).readQuota()).rejects.toThrow(
      /not signed in/,
    );
    native.installed.mockReturnValue(false);
    await expect((await createBinding()).readQuota()).rejects.toThrow(
      /not found/,
    );
  });
});

describe("request policy", () => {
  it.each([
    ["full-access", true],
    ["ask", false],
    ["auto", false],
  ] as const)(
    "maps %s to skipPermissions %s and passes cwd and tools through",
    async (permissionMode, skipPermissions) => {
      const { antigravity } = await import("./binding");
      const tools = {
        noop: {
          description: "Does nothing.",
          inputSchema: z.object({}),
          execute: async () => null,
          toModelOutput: (output: unknown) => output,
        },
      };
      const askPermission = vi.fn(async () => {});
      expect(
        antigravity.requestOptions({
          cwd: "/workspace",
          tools,
          permissionMode,
          askPermission,
        }),
      ).toEqual({ cwd: "/workspace", tools, skipPermissions });
      expect(askPermission).not.toHaveBeenCalled();
    },
  );

  it("defaults to medium effort, then high, then the only one listed", async () => {
    const { antigravity } = await import("./binding");
    const model = (availableVariants?: string[]) => ({
      kind: "language" as const,
      id: "m",
      providerID: ANTIGRAVITY,
      name: "M",
      capabilities: { input: {}, output: {} },
      availableVariants,
    });
    expect(
      antigravity.defaultOptions(model(["low", "medium", "high"])),
    ).toEqual({
      effort: "medium",
    });
    expect(antigravity.defaultOptions(model(["low", "high"]))).toEqual({
      effort: "high",
    });
    expect(antigravity.defaultOptions(model(["low"]))).toEqual({
      effort: "low",
    });
    expect(antigravity.defaultOptions(model([]))).toEqual({});
  });
});
