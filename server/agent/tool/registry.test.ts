// Purpose: Verifies the built-in registry and service-owned tool initialization.

import { Database } from "@openchart/server/db";
import { Parameters } from "@openchart/server/agent/tool/tools/echo";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { ToolRegistry } from "./registry";
import { Workflow } from "@openchart/server/agent/workflow";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session";
import { Workspaces } from "@openchart/server/workspace/workspace";
import { Home } from "@openchart/server/home";

test("exposes the built-in catalog and executes Echo", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service;
      const ids = yield* registry.ids();
      const all = yield* registry.all();
      const echo = all[0];
      if (!echo) throw new Error("Expected Echo");
      const output = yield* echo.execute(
        { text: "hello" },
        {
          rootRunID: "agr_test",
          sessionID: "session",
          messageID: "message",
          callID: "call",
          agent: "analyst",
          messages: [],
          metadata: () => Effect.die("Unexpected progress callback"),
          ask: () => Effect.void,
        },
      );
      return { ids, all, output };
    }).pipe(
      Effect.provide(ToolRegistry.layer),
      Effect.provide(AgentProfile.layerDefault),
      Effect.provide(Session.layer),
      Effect.provide(Database.layer(":memory:", () => Effect.void)),
      Effect.provideService(Home, { root: "/unused" }),
      Effect.provide(Layer.mock(Workspaces, {})),
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        settings: { concurrency: 5 },
        parentPrompt: {
          agent: "analyst",
          model: { providerID: "codex" as const, modelID: "tier1" as const },
          parts: [{ type: "text", text: "Test" }],
        },
        agent: () => Effect.die("Unexpected child execution"),
      }),
    ),
  );
  expect(result.ids).toEqual([
    "echo",
    "workflow",
    "task",
    "resource_read",
    "resource_mutate",
    "resource_search",
    "read_transcript",
    "search_transcript",
    "create_schedule",
  ]);
  expect(result.all.map((tool) => tool.id)).toEqual(result.ids);
  expect(result.all[0]?.parameters).toBe(Parameters);
  expect(result.output.output).toEqual({ type: "text", value: "echo hello" });
});

test("shares initialization within a service while isolating returned catalogs and service instances", async () => {
  const inspect = Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service;
    const first = yield* registry.all();
    const second = yield* registry.all();
    const echo = first[0];
    if (!echo) throw new Error("Expected Echo");
    expect(first).not.toBe(second);
    expect(second[0]).toBe(echo);
    first.pop();
    second[0] = { ...echo, id: "changed" };
    expect(yield* registry.ids()).toEqual([
      "echo",
      "workflow",
      "task",
      "resource_read",
      "resource_mutate",
      "resource_search",
      "read_transcript",
      "search_transcript",
      "create_schedule",
    ]);
    expect((yield* registry.all())[0]).toBe(echo);
    return echo;
  }).pipe(
    Effect.provide(ToolRegistry.layer),
    Effect.provide(AgentProfile.layerDefault),
  );

  const first = await Effect.runPromise(inspect);
  const second = await Effect.runPromise(inspect);
  expect(first).not.toBe(second);
  expect(first.execute).not.toBe(second.execute);
});
