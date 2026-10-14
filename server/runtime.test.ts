// Purpose: Application composition installs no feature plugins and shares one Events subscription.
import { temporaryHome } from "@openchart/server/home.test-utils";
import { PluginRegistry } from "@openchart/server/agent/plugin/registry";
import { ConfigProvider, Effect } from "effect";
import { ResourceChanged } from "@openchart/server/lib/resource/events";
import { expect, test } from "vitest";
import { makeRuntime } from "./runtime";
import { router } from "./index";

test("installs no feature plugins, so analyst prompts reject unowned plugin inputs", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
    models: { fetchEnabled: false, userAgent: "Reagent/PluginTest" },
  });
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.Service;
        const definitions = PluginRegistry.resolve(
          yield* registry.all(),
          "analyst",
        );
        expect(definitions).toEqual([]);
        expect(
          yield* Effect.flip(
            PluginRegistry.requireInputs(
              definitions,
              [{ type: "example_trigger", eventId: "evt_one" }],
              "analyst",
            ),
          ),
        ).toMatchObject({ agent: "analyst", input: "example_trigger" });
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

test("Resource changes reach the eagerly acquired Events subscription", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
  });
  const caller = router.createCaller({ runtime });
  const iterator = (await caller.events.subscribe())[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).value).toEqual({ kind: "ready" });
    const schedule = await caller.resources.agent_schedule.create({
      name: "Shared events",
      target: {
        kind: "agent_prompt",
        prompt: {
          agent: "analyst",
          model: { providerID: "codex", modelID: "tier1" },
          parts: [{ type: "text", text: "Research" }],
        },
      },
      recurrence: { kind: "once", fireAt: "2090-01-01T00:00:00.000Z" },
    });
    expect((await iterator.next()).value).toMatchObject({
      kind: "event",
      event: {
        type: ResourceChanged.type,
        data: { resource: "agent_schedule", id: schedule.id },
      },
    });
  } finally {
    await iterator.return?.();
    await runtime.dispose();
  }
});
