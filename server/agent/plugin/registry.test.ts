// Purpose: Verifies ordered plugin selection and immutable catalog ownership without profiles or setup.

import { Effect } from "effect";
import { expect, test } from "vitest";
import type { Definition } from "./contract";
import { PluginRegistry } from "./registry";

test("selects exact agent names in catalog order without constructing plugins", async () => {
  const definitions: Definition[] = [
    {
      id: "first",
      agents: ["analyst"],
      inputs: ["alert_trigger"],
      create: () => Effect.die("Discovery must not run setup"),
    },
    {
      id: "other",
      agents: ["other"],
      inputs: ["alert_trigger"],
      create: () => Effect.die("Discovery must not run setup"),
    },
    {
      id: "shared",
      agents: ["analyst", "other"],
      create: () => Effect.die("Discovery must not run setup"),
    },
  ];
  await Effect.runPromise(
    PluginRegistry.Service.use((registry) =>
      Effect.gen(function* () {
        const all = yield* registry.all();
        expect(all).toHaveLength(3);
        expect(
          PluginRegistry.resolve(all, "analyst").map((item) => item.id),
        ).toEqual(["first", "shared"]);
        expect(
          PluginRegistry.resolve(all, "other").map((item) => item.id),
        ).toEqual(["other", "shared"]);
        expect(PluginRegistry.resolve(all, "analyst-extra")).toEqual([]);
      }),
    ).pipe(Effect.provide(PluginRegistry.layer(definitions))),
  );
});

test("catalog definitions and selectors do not borrow mutable registration data", async () => {
  const agents = ["analyst"];
  const definitions: Definition[] = [
    {
      id: "context",
      agents,
      create: () => Effect.succeed({}),
    },
  ];
  await Effect.runPromise(
    PluginRegistry.Service.use((registry) =>
      Effect.gen(function* () {
        const captured = PluginRegistry.resolve(
          yield* registry.all(),
          "analyst",
        );
        agents.splice(0);
        definitions.splice(0);
        expect(
          PluginRegistry.resolve(yield* registry.all(), "analyst"),
        ).toEqual(captured);
        expect(captured.map((item) => item.id)).toEqual(["context"]);
        expect(() => (captured[0]!.agents as string[]).push("other")).toThrow();
      }),
    ).pipe(Effect.provide(PluginRegistry.layer(definitions))),
  );
});
