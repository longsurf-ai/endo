// Purpose: Verifies OpenCode product policy without a native runtime or inference requests.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AvailableProvider,
  type ModelProvider,
} from "@openchart/models/model-provider";
import { OPENCODE } from "@openchart/models/model-tiers";

const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  discover: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@openchart/models/providers/executable", () => ({
  hasExecutable: mocks.installed,
}));
vi.mock("./adapter/index", () => ({
  OPENCODE_PROVIDER: "opencode",
  createOpenCodeProvider: mocks.create,
}));
const bindings: ModelProvider[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.installed.mockReturnValue(true);
  mocks.discover.mockResolvedValue([]);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.create.mockReturnValue({
    discoverModels: mocks.discover,
    dispose: mocks.dispose,
    languageModel: vi.fn(),
  });
});
afterEach(async () => {
  await Promise.all(bindings.splice(0).map((binding) => binding.dispose()));
});
async function binding() {
  const { opencode } = await import("./binding");
  const catalog = { get: vi.fn(async () => ({})) };
  const result = opencode.createModelProvider(catalog, "/managed/opencode");
  bindings.push(result);
  return { result, catalog, opencode };
}
it("constructs lazily and checks only the managed executable", async () => {
  const { result } = await binding();
  expect(result.id).toBe(OPENCODE);
  expect(mocks.installed).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.installed.mockReturnValue(false);
  await expect(result.discover()).resolves.toEqual({ status: "not_installed" });
  expect(mocks.create).not.toHaveBeenCalled();
});
it("preserves native IDs, names and variants without inventing tiers, costs or quotas", async () => {
  const { result } = await binding();
  mocks.discover.mockResolvedValue([
    {
      id: "private/model/with/slashes",
      name: "Custom",
      availableVariants: ["high"],
    },
  ]);
  const discovery = await result.discover();
  if (discovery.status !== "ready") throw new Error("Not ready");
  const provider = AvailableProvider.parse(discovery.provider);
  expect(provider.models[0]).toMatchObject({
    id: "private/model/with/slashes",
    providerID: OPENCODE,
    availableVariants: ["high"],
  });
  expect(provider.models[0]?.tier).toBeUndefined();
  expect(provider.models[0]?.cost).toBeUndefined();
  expect(provider.models[0]?.limit).toBeUndefined();
  await expect(result.readQuota()).resolves.toEqual({
    status: "ready",
    meters: [],
  });
  expect(mocks.discover).toHaveBeenCalledOnce();
});
it("does not return a late discovery after terminal disposal", async () => {
  const { result } = await binding();
  let resolve!: (models: []) => void;
  mocks.discover.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = result.discover();
  const assertion = expect(pending).rejects.toThrow("disposed");
  await result.dispose();
  resolve([]);
  await assertion;
  await result.dispose();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(() => result.sdk).toThrow("disposed");
});
it("binds permissions and questions to each request, preserving choice values", async () => {
  const { opencode } = await binding();
  const askPermission = vi.fn(async () => {});
  const askQuestion = vi.fn(async () => ({
    type: "answered" as const,
    answers: { pm: ["Node"], features: ["Tests", "Docs"] },
  }));
  const request = opencode.requestOptions({
    cwd: "/workspace",
    tools: {},
    permissionMode: "ask",
    askPermission,
    askQuestion,
  });
  const signal = new AbortController().signal;
  expect(
    await request.approve(
      {
        kind: "execute",
        name: "shell",
        title: "Test",
        input: { command: "node --test" },
      },
      signal,
    ),
  ).toBe(true);
  expect(askPermission).toHaveBeenCalledWith(
    expect.objectContaining({
      permission: "run_command",
      patterns: ["node --test"],
    }),
  );
  askPermission.mockRejectedValueOnce(new Error("Declined"));
  expect(
    await request.approve(
      {
        kind: "edit",
        name: "write",
        title: "Write",
        input: { filePath: "/workspace/a" },
      },
      signal,
    ),
  ).toBe(false);
  const answer = await request.answer!(
    {
      message: "Options",
      requestedSchema: {
        type: "object",
        properties: {
          pm: { type: "string", oneOf: [{ const: "node", title: "Node" }] },
          features: {
            type: "array",
            items: {
              anyOf: [
                { const: "test", title: "Tests" },
                { const: "docs", title: "Docs" },
              ],
            },
          },
        },
      },
    },
    signal,
  );
  expect(answer).toEqual({ pm: "node", features: ["test", "docs"] });
  expect(askQuestion).toHaveBeenCalledWith(
    expect.objectContaining({
      questions: expect.arrayContaining([
        expect.objectContaining({ id: "features", multiple: true }),
      ]),
    }),
    { signal },
  );
});
