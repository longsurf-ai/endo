// Purpose: Verifies option merging, SDK namespaces, and immutable message projection against fixture native providers.
import { CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";
import { describe, expect, test } from "vitest";
import { AvailableModel } from "./model-provider";
import type { NativeProvider } from "./native-provider";
import { ProviderTransform } from "./transform";

function createModel(input?: {
  providerID?: string;
  id?: string;
}): AvailableModel {
  const providerID = input?.providerID ?? CODEX;
  const id = input?.id ?? "gpt-5.6-luna";
  return {
    id,
    kind: "language",
    name: id,
    providerID,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
    },
    limit: {
      context: 200_000,
      output: 16_384,
    },
    availableVariants: ["low", "medium", "high", "xhigh"],
  };
}

function fixtureProvider(
  provider: Pick<NativeProvider, "id" | "sdkKey"> & Partial<NativeProvider>,
): NativeProvider {
  return {
    createModelProvider: () => {
      throw new Error("Transforms never construct bindings");
    },
    requestOptions: () => ({}),
    ...provider,
  };
}

// Fixture providers isolate the transform contract from real binding policy.
const codex = fixtureProvider({
  id: CODEX,
  sdkKey: "codex-app-server",
  defaultOptions: () => ({ effort: "medium" }),
});
const claudeCode = fixtureProvider({
  id: CLAUDE_CODE,
  sdkKey: CLAUDE_CODE,
  normalizeMessages: (messages) =>
    messages.map((message) =>
      message.role === "assistant"
        ? { ...message, content: "normalized" }
        : message,
    ),
});

describe("ProviderTransform.options", () => {
  test("merges native defaults, explicit options, and the selected variant without mutation", () => {
    const model = createModel();
    const overrides = { effort: "low", nested: { caller: true } };
    const before = structuredClone({ model, overrides });

    expect(ProviderTransform.options({ model }, codex)).toEqual({
      effort: "medium",
    });
    expect(ProviderTransform.options({ model }, codex, overrides)).toEqual(
      overrides,
    );
    expect(
      ProviderTransform.options({ model, variant: "high" }, codex, overrides),
    ).toEqual({ effort: "high", nested: { caller: true } });
    expect({ model, overrides }).toEqual(before);
  });

  test.each(["openai", "anthropic"])(
    "passes explicit %s SDK options through without native defaults or variant translation",
    (providerID) => {
      const model = createModel({ providerID });
      const overrides = { custom: { enabled: true } };
      expect(ProviderTransform.options({ model }, undefined)).toEqual({});
      expect(
        ProviderTransform.options({ model }, undefined, overrides),
      ).toEqual(overrides);
      expect(() =>
        ProviderTransform.options({ model, variant: "high" }, undefined),
      ).toThrow("Unsupported variant");
    },
  );

  test.each([claudeCode, codex])(
    "translates a $id variant into the native effort name without catalog metadata",
    (provider) => {
      const model = AvailableModel.parse({
        kind: "language",
        id: "native-alias",
        name: "Native model",
        providerID: provider.id,
        capabilities: { input: {}, output: {} },
        availableVariants: ["high"],
      });
      expect(
        ProviderTransform.options({ model, variant: "high" }, provider),
      ).toMatchObject({ effort: "high" });
    },
  );
});

describe("ProviderTransform.providerOptions", () => {
  test("uses the native adapter's namespace", () => {
    const canUseTool = async () => ({ behavior: "allow" }) as const;
    expect(
      ProviderTransform.providerOptions(
        createModel({ providerID: CLAUDE_CODE, id: "claude-sonnet-5" }),
        claudeCode,
        { canUseTool },
      ),
    ).toEqual({ [CLAUDE_CODE]: { canUseTool } });
    expect(
      ProviderTransform.providerOptions(
        createModel({ providerID: CODEX, id: "gpt-5.6-sol" }),
        codex,
        { effort: "medium" },
      ),
    ).toEqual({ "codex-app-server": { effort: "medium" } });
  });

  test("uses the provider ID for a plain AI SDK provider", () => {
    expect(
      ProviderTransform.providerOptions(
        createModel({ providerID: "openai" }),
        undefined,
        { effort: "low" },
      ),
    ).toEqual({ openai: { effort: "low" } });
  });
});

describe("ProviderTransform.message", () => {
  test("leaves cache policy to the caller without annotating the transcript", () => {
    const messages = [
      { role: "system", content: "stable header" },
      { role: "system", content: "volatile tail" },
      { role: "user", content: "first" },
      { role: "assistant", content: "middle" },
      { role: "user", content: "latest" },
    ] as Parameters<typeof ProviderTransform.message>[0];
    const original = structuredClone(messages);
    const model = createModel({ providerID: CODEX, id: "gpt-5.6-luna" });

    const result = ProviderTransform.message(messages, model, codex);

    expect(result).toEqual(original);
    expect(messages).toEqual(original);
    expect(ProviderTransform.message(result, model, codex)).toEqual(result);
  });

  test("preserves JSON Schema in native tool results", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "resource_read",
            output: { type: "json", value: { schema: { $ref: "#/$defs/x" } } },
          },
        ],
      },
    ] as Parameters<typeof ProviderTransform.message>[0];
    const model = createModel({ providerID: CODEX, id: "gpt-5.6-luna" });

    const result = ProviderTransform.message(messages, model, codex);

    const output = (result[0] as { content: Array<{ output: unknown }> })
      .content[0]!.output as { value: unknown };
    expect(output.value).toEqual({ schema: { $ref: "#/$defs/x" } });
  });

  test("applies the native provider's normalization to a clone", () => {
    const messages = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ] as Parameters<typeof ProviderTransform.message>[0];
    const model = createModel({ providerID: CLAUDE_CODE, id: "sonnet" });

    const result = ProviderTransform.message(messages, model, claudeCode);

    expect(result[1]).toMatchObject({ content: "normalized" });
    expect(messages[1]).toMatchObject({ content: "answer" });
  });

  test("moves stored providerOptions from the provider ID to the SDK namespace", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            providerOptions: { [CODEX]: { cache: true } },
          },
        ],
        providerOptions: { [CODEX]: { effort: "low" }, other: { kept: 1 } },
      },
    ] as Parameters<typeof ProviderTransform.message>[0];
    const model = createModel({ providerID: CODEX, id: "gpt-5.6-luna" });

    const result = ProviderTransform.message(messages, model, codex);

    expect(result[0]!.providerOptions).toEqual({
      "codex-app-server": { effort: "low" },
      other: { kept: 1 },
    });
    expect(result[0]!.content[0]).toMatchObject({
      providerOptions: { "codex-app-server": { cache: true } },
    });
    expect(messages[0]!.providerOptions).toEqual({
      [CODEX]: { effort: "low" },
      other: { kept: 1 },
    });
  });
});

test.each([undefined, true, false])(
  "only blocks explicitly unsupported image input (%s)",
  (image) => {
    const model = AvailableModel.parse({
      kind: "language",
      providerID: CODEX,
      id: "gpt-5-test",
      name: "Test",
      capabilities: { input: { image }, output: {} },
    });
    const messages = [
      {
        role: "user",
        content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
      },
    ] as Parameters<typeof ProviderTransform.message>[0];
    const result = ProviderTransform.message(messages, model, codex);
    expect(result[0]!.content[0]).toMatchObject({
      type: image === false ? "text" : "image",
    });
    expect(messages[0]!.content[0]).toMatchObject({ type: "image" });
  },
);
