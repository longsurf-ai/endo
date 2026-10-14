// Purpose: Verifies profile lookup, OpenChart prompts, configuration, and scoped registry updates.

import { CODEX } from "@openchart/models/model-tiers";

import { resources } from "@openchart/server/resources/catalog";
import { evaluate } from "@openchart/server/agent/permission/rules";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, test } from "vitest";
import { AgentProfile } from "./profile";
import { State } from "./state";

function run<A, E>(
  program: Effect.Effect<A, E, AgentProfile.Service | Scope.Scope>,
  configuration: AgentProfile.Configuration = {},
) {
  return Effect.runPromise(
    Effect.scoped(program).pipe(
      Effect.provide(AgentProfile.layer(configuration)),
    ),
  );
}

test("provides the three OpenChart profiles without models, tools, or Permission services", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const all = yield* profiles.all();
      expect(all.map((info) => info.name)).toEqual([
        "analyst",
        "title",
        "compaction",
      ]);
      expect(yield* profiles.resolve()).toBe(
        yield* profiles.resolve("analyst"),
      );
      expect(yield* profiles.resolve("title")).toMatchObject({
        mode: "primary",
        hidden: true,
      });
      expect(yield* profiles.resolve("compaction")).toMatchObject({
        mode: "primary",
        hidden: true,
      });
      for (const info of all) {
        expect(evaluate("echo", "*", info.permission).decision).toBe(
          info.name === "analyst" ? "allow" : "deny",
        );
        expect(
          evaluate(
            "workflow",
            "default:workflows/best-of-n.workflow.ts",
            info.permission,
          ).decision,
        ).toBe(info.name === "analyst" ? "allow" : "deny");
        // The app's own tools, delegation included, need no approval by default.
        expect(evaluate("task", "analyst", info.permission).decision).toBe(
          info.name === "analyst" ? "allow" : "deny",
        );
        for (const action of [
          "resource_read",
          "resource_search",
          "resource_mutate",
          "read_transcript",
          "search_transcript",
          "create_schedule",
        ]) {
          expect(evaluate(action, "*", info.permission).decision).toBe(
            info.name === "analyst" ? "allow" : "deny",
          );
        }
        expect(evaluate("run_command", "*", info.permission).decision).toBe(
          "deny",
        );
        expect(info.model).toBeUndefined();
        expect(info.selectedVariant).toBeUndefined();
      }
    }),
  );
});

test("describes only implemented tools and the current Resource catalog", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const analyst = yield* profiles.resolve("analyst");
      const title = yield* profiles.resolve("title");
      const compaction = yield* profiles.resolve("compaction");
      expect(analyst?.prompt).toContain("You are a helpful assistant");
      expect(analyst?.prompt).toContain(
        "Be objective and fact-first, back your argument with evidence.",
      );
      expect(analyst?.prompt).toContain("<identity>");
      expect(analyst?.prompt).toContain("<communication>");
      expect(analyst?.prompt.match(/^<([a-z_]+)>$/gm)).toEqual([
        "<identity>",
        "<communication>",
        "<resources>",
        "<schedules>",
      ]);
      expect(analyst?.prompt).not.toContain("{{");
      for (const resource of resources)
        expect(analyst?.prompt).toContain(resource.name);
      for (const legacy of [
        "Resource Tree",
        "/dashboards/",
        "schema_info",
        "TCAC",
        "sandbox",
        "indicator_definition",
      ])
        expect(analyst?.prompt).not.toContain(legacy);
      expect(analyst?.prompt).toContain("expected_revision");
      expect(analyst?.prompt).toContain(
        "custom transitions require a dedicated tool",
      );
      expect(analyst?.prompt).toContain("create_schedule");
      expect(title?.prompt).toContain("same language as the user");
      expect(title?.prompt).toContain("≤50 characters");
      expect(title?.prompt).toContain("Never use tools");
      expect(compaction?.prompt).toContain(
        "Key user requests, constraints, or preferences",
      );
    }),
  );
});

test("keeps explicit missing profiles unresolved and makes hidden profiles addressable", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      expect(yield* profiles.resolve("missing")).toBeUndefined();
      expect(yield* profiles.resolve("title")).toMatchObject({
        name: "title",
        hidden: true,
      });
    }),
  );
});

test("applies configuration after built-ins and preserves ordered permission overrides", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const title = yield* profiles.resolve("title");
      expect(title).toMatchObject({
        prompt: "  Keep the custom prompt verbatim.\n",
        temperature: 0,
        topP: 0.8,
        steps: 2,
        model: { providerID: CODEX, modelID: "tier3" },
        selectedVariant: "high",
        options: { reasoning: { effort: "high" } },
      });
      expect(title?.permission).toEqual([
        { action: "*", resource: "*", decision: "deny" },
        { action: "read", resource: "*", decision: "ask" },
        { action: "read", resource: "/notes/*", decision: "allow" },
      ]);
      expect(yield* profiles.resolve("compaction")).toBeUndefined();
      expect(yield* profiles.resolve()).toMatchObject({
        name: "reviewer",
        mode: "all",
      });
      expect((yield* profiles.resolve("reviewer"))?.permission).toEqual([
        { action: "*", resource: "*", decision: "deny" },
        { action: "read", resource: "*", decision: "ask" },
      ]);
      // V1's variant field can exist independently of a model preference.
      expect(yield* profiles.resolve("analyst")).toMatchObject({
        selectedVariant: "low",
      });
    }),
    {
      default: "reviewer",
      permission: [{ action: "read", resource: "*", decision: "ask" }],
      agents: {
        title: {
          prompt: "  Keep the custom prompt verbatim.\n",
          temperature: 0,
          topP: 0.8,
          steps: 2,
          model: { providerID: CODEX, modelID: "tier3" },
          selectedVariant: "high",
          options: { reasoning: { effort: "high" } },
          permission: [
            { action: "read", resource: "/notes/*", decision: "allow" },
          ],
        },
        analyst: { selectedVariant: "low" },
        compaction: { disabled: true },
        reviewer: { prompt: "Review carefully." },
      },
    },
  );
});

describe("default selection follows configured preference and visibility", () => {
  test.each(["missing", "title", "delegate"])(
    "skips ineligible configured default %s",
    async (preferred) => {
      await run(
        Effect.gen(function* () {
          const profiles = yield* AgentProfile.Service;
          expect((yield* profiles.resolve())?.name).toBe("analyst");
        }),
        {
          default: preferred,
          agents: { delegate: { prompt: "Delegate.", mode: "subagent" } },
        },
      );
    },
  );

  test("uses another visible primary profile when analyst is disabled", async () => {
    await run(
      Effect.gen(function* () {
        const profiles = yield* AgentProfile.Service;
        expect((yield* profiles.resolve())?.name).toBe("reviewer");
      }),
      {
        agents: {
          analyst: { disabled: true },
          reviewer: { prompt: "Review." },
        },
      },
    );
  });

  test("returns undefined when no selectable default profile exists", async () => {
    await run(
      Effect.gen(function* () {
        const profiles = yield* AgentProfile.Service;
        expect(yield* profiles.resolve()).toBeUndefined();
      }),
      { agents: { analyst: { disabled: true } } },
    );
  });
});

test("replays updates and restores earlier definitions when registrations are disposed", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const original = yield* profiles.resolve("analyst");
      let prompt = "First revision.";
      const registration = yield* profiles.transform((draft) => {
        draft.update("analyst", (info) => {
          info.prompt = prompt;
        });
      });
      expect((yield* profiles.resolve("analyst"))?.prompt).toBe(prompt);
      prompt = "Second revision.";
      yield* profiles.reload();
      expect((yield* profiles.resolve("analyst"))?.prompt).toBe(prompt);
      yield* registration.dispose;
      yield* registration.dispose;
      expect(yield* profiles.resolve("analyst")).toEqual(original);
    }),
  );
});

test("isolates mutable permission drafts from other profiles and configuration", async () => {
  const configuration: AgentProfile.Configuration = {
    permission: [{ action: "read", resource: "*", decision: "ask" }],
  };
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const registration = yield* profiles.transform((draft) => {
        draft.update("title", (info) => {
          const rule = info.permission[1];
          if (!rule) throw new Error("Expected the configured rule");
          rule.decision = "allow";
        });
      });
      expect((yield* profiles.resolve("title"))?.permission[1]?.decision).toBe(
        "allow",
      );
      const analyst = yield* profiles.resolve("analyst");
      expect(evaluate("read", "/notes/a", analyst!.permission).decision).toBe(
        "ask",
      );
      expect(configuration.permission?.[0]?.decision).toBe("ask");
      yield* registration.dispose;
      expect((yield* profiles.resolve("title"))?.permission[1]?.decision).toBe(
        "ask",
      );
    }),
    configuration,
  );
});

test("removes scoped additions and restores removals and the prior default on scope close", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const scope = yield* Scope.make();
      yield* profiles
        .transform((draft) => {
          draft.remove("title");
          draft.update("reviewer", (info) => {
            info.name = "cannot-rename-the-key";
            info.prompt = "Review.";
          });
          draft.default("reviewer");
        })
        .pipe(Scope.provide(scope));
      expect((yield* profiles.resolve())?.name).toBe("reviewer");
      expect(yield* profiles.resolve("cannot-rename-the-key")).toBeUndefined();
      expect(yield* profiles.resolve("title")).toBeUndefined();
      yield* Scope.close(scope, Exit.void);
      expect((yield* profiles.resolve())?.name).toBe("analyst");
      expect(yield* profiles.resolve("reviewer")).toBeUndefined();
      expect(yield* profiles.resolve("title")).toBeDefined();
    }),
  );
});

test("publishes effectful updates atomically while readers retain the previous registry", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const original = yield* profiles.all();
      const fiber = yield* profiles
        .transform((draft) =>
          Effect.gen(function* () {
            draft.update("analyst", (info) => {
              info.prompt = "Updated.";
            });
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            draft.remove("title");
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(yield* profiles.all()).toEqual(original);
      yield* Deferred.succeed(release, undefined);
      const registration = yield* Fiber.join(fiber);
      expect((yield* profiles.resolve("analyst"))?.prompt).toBe("Updated.");
      expect(yield* profiles.resolve("title")).toBeUndefined();
      yield* registration.dispose;
      expect(yield* profiles.all()).toEqual(original);
    }),
  );
});

test("nested registration batches and scope cleanup each publish one complete rebuild", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const scope = yield* Scope.make();
      let rebuilds = 0;
      yield* profiles.transform(() => {
        rebuilds++;
      });
      const original = yield* profiles.all();
      rebuilds = 0;

      yield* State.batch(
        Effect.gen(function* () {
          yield* profiles
            .transform((draft) => draft.remove("title"))
            .pipe(Scope.provide(scope));
          yield* State.batch(
            profiles
              .transform((draft) => draft.remove("compaction"))
              .pipe(Scope.provide(scope)),
          );
          expect(rebuilds).toBe(0);
          expect(yield* profiles.all()).toEqual(original);
        }),
      );
      expect(rebuilds).toBe(1);
      expect(yield* profiles.resolve("title")).toBeUndefined();
      expect(yield* profiles.resolve("compaction")).toBeUndefined();

      yield* State.batch(
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void);
          expect(rebuilds).toBe(1);
          expect(yield* profiles.resolve("title")).toBeUndefined();
        }),
      );
      expect(rebuilds).toBe(2);
      expect(yield* profiles.all()).toEqual(original);
    }),
  );
});

test("rejects incomplete custom profiles without poisoning subsequent registrations", async () => {
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      const original = yield* profiles.all();
      const failed = yield* Effect.exit(
        profiles.transform((draft) => {
          draft.remove("title");
          draft.update("incomplete", (info) => {
            info.description = "Missing prompt.";
          });
        }),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* profiles.all()).toEqual(original);
      yield* profiles.transform((draft) => {
        draft.update("reviewer", (info) => {
          info.prompt = "Review.";
        });
      });
      expect(yield* profiles.resolve("reviewer")).toBeDefined();
    }),
  );
});

test("keeps service instances and returned catalog arrays independent", async () => {
  const inspect = Effect.gen(function* () {
    const profiles = yield* AgentProfile.Service;
    return { profiles, all: yield* profiles.all() };
  });
  const first = await run(inspect);
  const second = await run(inspect);
  expect(first.profiles).not.toBe(second.profiles);
  expect(first.all[0]).not.toBe(second.all[0]);
  await run(
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      expect(yield* profiles.all()).not.toBe(yield* profiles.all());
    }),
  );
});
