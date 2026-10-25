// Purpose: Proves per-request instruction overlays preserve restrictions and avoid native config expansion.
import { expect, it } from "vitest";
import { requestEnvironment } from "./native-config";

it("preserves inherited provider restrictions and unrelated configuration", () => {
  const inline = {
    policies: [{ action: "provider.use", resource: "*", effect: "deny" }],
    providers: { custom: { name: "Private {ENV:PROVIDER_LABEL}" } },
    agents: { personal: { system: "User agent" } },
  };
  const inherited = {
    HOME: "/example",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inline),
  };
  const before = structuredClone(inherited);
  const result = requestEnvironment(
    inherited,
    "custom/model",
    "Endo instructions",
  );
  const content = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!);
  expect(content.policies).toEqual(inline.policies);
  expect(content.providers).toEqual(inline.providers);
  expect(result.env.OPENCODE_CONFIG_CONTENT).toContain("{ENV:PROVIDER_LABEL}");
  expect(content.agents.personal).toEqual(inline.agents.personal);
  expect(content.agents[result.agent].permissions).toEqual([
    { action: "*", resource: "*", effect: "ask" },
  ]);
  expect(content.model).toBe("custom/model");
  expect(content.small_model).toBe("custom/model");
  expect(inherited).toEqual(before);
});

it("keeps file/environment references in instructions literal", () => {
  const system =
    'Treat {file:/private/example} and {env:TOKEN}, {ENV:TOKEN}, {FiLe:/private/example} as literal text. "Unicode: λ"';
  const result = requestEnvironment({}, "custom/model", system);
  expect(result.env.OPENCODE_CONFIG_CONTENT).not.toContain("{file:");
  expect(result.env.OPENCODE_CONFIG_CONTENT).not.toMatch(/\{(?:file|env):/i);
  expect(
    JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!).agents[result.agent].system,
  ).toBe(system);
});

it("fails closed rather than discarding an unreadable inherited overlay", () => {
  expect(() =>
    requestEnvironment(
      { OPENCODE_CONFIG_CONTENT: "invalid" },
      "custom/model",
      "system",
    ),
  ).toThrow("preserve its settings");
});

it.each(["$$", "$&", "$`", "$'"])(
  "preserves replacement pattern %s in instructions and model IDs",
  (pattern) => {
    const system = "Literal " + pattern + ' with "quotes" and {ENV:TOKEN}';
    const modelId = "custom/model-" + pattern;
    const inline = {
      providers: { custom: { apiKey: "synthetic-inline-secret" } },
      agents: { personal: { system: "Inherited agent" } },
    };
    const result = requestEnvironment(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) },
      modelId,
      system,
    );
    const content = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!);
    expect(content.agents[result.agent].system).toBe(system);
    expect(content.agents[result.agent].model).toBe(modelId);
    expect(content.model).toBe(modelId);
    expect(content.small_model).toBe(modelId);
    expect(content.providers).toEqual(inline.providers);
    expect(content.agents.personal).toEqual(inline.agents.personal);
    expect(JSON.stringify(content.agents[result.agent])).not.toContain(
      "synthetic-inline-secret",
    );
  },
);
