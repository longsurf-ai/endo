// Purpose: Exercises plugin preparation through real Prompt, Session, and SDK execution.

import { PluginContext } from "@openchart/server/agent/contracts/part";
import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { LLM } from "@openchart/server/agent/llm";
import { Plugin } from "@openchart/server/agent/plugin";
import { PluginRegistry } from "@openchart/server/agent/plugin/registry";
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { expect, test } from "vitest";
import { execute } from "./execute";
import { answer, finish, run } from "./prompt.test-utils";

test("prepares hidden context once before model I/O and retains the admitted profile", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const profiles = yield* AgentProfile.Service;
      let prepared = 0;
      const plugin = yield* Plugin.bind({
        id: "context",
        agents: ["analyst"],
        inputs: ["alert_trigger"],
        create: (invocation) =>
          Effect.succeed({
            "run.before": () =>
              Effect.gen(function* () {
                const user = yield* fixture.session.getMessage({
                  sessionID: invocation.sessionID,
                  messageID: invocation.triggerMessageID,
                });
                expect(user?.info.role).toBe("user");
                expect(invocation.pluginInputs).toEqual([
                  { type: "alert_trigger", eventId: "event" },
                ]);
                yield* profiles.transform((draft) =>
                  draft.update("analyst", (info) => {
                    info.steps = 9;
                    info.prompt = "Configuration for the next invocation.";
                  }),
                );
                prepared++;
                return [
                  Schema.decodeUnknownSync(PluginContext)({
                    kind: "plugin",
                    pluginId: "context",
                    hook: "run.before",
                    content: "Trusted context",
                  }),
                ];
              }),
          }),
      });
      yield* profiles.transform((draft) => {
        draft.update("analyst", (info) => {
          info.steps = 1;
        });
      });
      fixture.run.input.parts = [
        {
          type: "plugin_input",
          input: { type: "alert_trigger", eventId: "event" },
        },
      ];
      fixture.source = () =>
        fixture.calls.length === 1
          ? [
              {
                ...finish,
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              },
            ]
          : answer;
      yield* execute(fixture.run).pipe(
        Effect.provide(
          PluginRegistry.layer([
            {
              ...plugin,
              id: "other-profile",
              agents: ["other"],
              create: () => Effect.die("An unrelated plugin must never start"),
            },
            plugin,
          ]),
        ),
      );
      expect(prepared).toBe(1);
      expect(fixture.calls).toHaveLength(2);
      const transcript = yield* fixture.session.readTranscriptPage({
        sessionID: fixture.run.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(JSON.stringify(transcript)).toContain("Trusted context");
      const messages = yield* fixture.session.listMessages({
        sessionID: fixture.run.sessionID,
        limit: 100,
      });
      const parts = messages.items.flatMap((message) => message.parts);
      expect(
        parts.filter(
          (part) => part.type === "context" && part.context.kind === "plugin",
        ),
      ).toHaveLength(1);
      for (const request of fixture.calls) {
        const prompt = JSON.stringify(request.prompt);
        expect(prompt).toContain("Trusted context");
        expect(prompt).not.toContain("alert_trigger");
        expect(prompt).toContain("MAXIMUM STEPS REACHED");
        expect(prompt).not.toContain("Configuration for the next invocation.");
      }
    }),
  );
});

test("provides one service across execution and fresh services to workflow children", async () => {
  await run(
    (fixture) =>
      Effect.gen(function* () {
        const llm = yield* LLM.Service;
        const created: Plugin.Invocation[] = [];
        const prepared: string[] = [];
        const released: string[] = [];
        const services = new Map<string, Plugin.Interface>();
        const plugin: Plugin.Definition = {
          id: "context",
          agents: ["analyst"],
          create: (invocation) =>
            Effect.gen(function* () {
              created.push(invocation);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released.push(invocation.sessionID);
                }),
              );
              return {
                "run.before": () =>
                  Effect.gen(function* () {
                    services.set(
                      invocation.sessionID,
                      Option.getOrThrow(
                        yield* Effect.serviceOption(Plugin.Service),
                      ),
                    );
                    prepared.push(invocation.sessionID);
                  }),
              };
            }),
        };
        fixture.run.input.parts = [
          {
            type: "workflow",
            workflow: "default:workflows/best-of-n.workflow.ts",
            args: { n: 3, question: "Test child invocation isolation" },
          },
        ];
        // Exercise the same prompt service from two different root model steps.
        fixture.source = () =>
          fixture.calls.length === 5
            ? [
                {
                  ...finish,
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ]
            : answer;
        yield* execute(fixture.run).pipe(
          Effect.provideService(LLM.Service, {
            stream: (input) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const plugins = Option.getOrThrow(
                    yield* Effect.serviceOption(Plugin.Service),
                  );
                  expect(plugins).toBe(services.get(input.sessionID));
                  expect(released).not.toContain(input.sessionID);
                  return llm.stream(input);
                }),
              ),
          }),
          Effect.provide(PluginRegistry.layer([plugin])),
        );
        expect(created).toHaveLength(5);
        expect(new Set(created.map((context) => context.sessionID)).size).toBe(
          5,
        );
        expect(
          created.every((context) => context.runID === fixture.run.id),
        ).toBe(true);
        expect(new Set(services.values()).size).toBe(5);
        expect([...prepared].sort()).toEqual(
          created.map((context) => context.sessionID).sort(),
        );
        expect([...released].sort()).toEqual([...prepared].sort());
        expect(released.at(-1)).toBe(fixture.run.sessionID);
        expect(fixture.calls).toHaveLength(6);
        expect(Option.isNone(yield* Effect.serviceOption(Plugin.Service))).toBe(
          true,
        );
      }),
    {
      agents: {
        analyst: {
          permission: [
            { action: "workflow", resource: "*", decision: "allow" },
          ],
        },
      },
    },
  );
});

test("keeps the service alive through model execution and cleans it on cancellation", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let released = false;
      const fiber = yield* execute(fixture.run).pipe(
        Effect.provideService(LLM.Service, {
          stream: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                expect(
                  Option.isSome(yield* Effect.serviceOption(Plugin.Service)),
                ).toBe(true);
                expect(released).toBe(false);
                yield* Deferred.succeed(started, undefined);
                return Stream.never;
              }),
            ),
        }),
        Effect.provide(
          PluginRegistry.layer([
            {
              id: "context",
              agents: ["analyst"],
              create: () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      released = true;
                    }),
                  );
                  return {};
                }),
            },
          ]),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(released).toBe(true);
    }),
  );
});

test.each([false, true])(
  "keeps supplied context and all results from the same hook: %s",
  async (matchingHook) => {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.run.input = Schema.decodeUnknownSync(AgentPromptInput)({
          ...fixture.run.input,
          parts: [
            {
              id: "prt_supplied",
              type: "context",
              context: {
                kind: "plugin",
                pluginId: "research",
                hook: "run.before",
                content: "Supplied context",
              },
            },
          ],
        });
        yield* execute(fixture.run).pipe(
          Effect.provide(
            PluginRegistry.layer(
              matchingHook
                ? [
                    {
                      id: "research",
                      agents: ["analyst"],
                      create: () =>
                        Effect.succeed({
                          "run.before": () =>
                            Effect.succeed([
                              Schema.decodeUnknownSync(PluginContext)({
                                kind: "plugin",
                                pluginId: "research",
                                hook: "run.before",
                                content: "Supplied context",
                              }),
                              Schema.decodeUnknownSync(PluginContext)({
                                kind: "plugin",
                                pluginId: "research",
                                hook: "run.before",
                                content: "Second context from the same hook",
                              }),
                            ]),
                        }),
                    },
                  ]
                : [],
            ),
          ),
        );
        const messages = (yield* fixture.session.listMessages({
          sessionID: fixture.run.sessionID,
          limit: 100,
        })).items;
        const parts = messages[0]!.parts;
        expect(parts).toHaveLength(matchingHook ? 3 : 1);
        expect(parts).toContainEqual({
          ...fixture.run.input.parts[0],
          messageID: messages[0]!.info.id,
        });
        expect(new Set(parts.map((part) => part.id)).size).toBe(parts.length);
        for (const part of parts) {
          expect(part).toMatchObject({
            type: "context",
            messageID: messages[0]!.info.id,
            context: {
              kind: "plugin",
              pluginId: "research",
              hook: "run.before",
            },
          });
        }
        expect(fixture.calls).toHaveLength(1);
        const prompt = JSON.stringify(fixture.calls[0]!.prompt);
        expect(prompt).toContain("Supplied context");
        expect(prompt.includes("Second context from the same hook")).toBe(
          matchingHook,
        );
        expect(prompt).not.toContain("trusted application context");
        expect(prompt).not.toContain("not user-authored");
      }),
    );
  },
);

test.each([
  "unhandled",
  "duplicate-id",
  "duplicate-input",
  "prepare-failure",
  "setup-failure",
] as const)(
  "%s prevents model calls and leaves no unfinished Assistant",
  async (failure) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const definitions: Plugin.Definition[] = [];
        if (failure === "unhandled") {
          fixture.run.input.parts = [
            {
              type: "plugin_input",
              input: { type: "alert_trigger", eventId: "event" },
            },
          ];
        } else if (
          failure === "duplicate-id" ||
          failure === "duplicate-input"
        ) {
          const plugin: Plugin.Definition = {
            id: "first",
            agents: ["analyst"],
            inputs: ["alert_trigger"],
            create: () => Effect.die("Invalid selection must never start"),
          };
          definitions.push(plugin, {
            ...plugin,
            id: failure === "duplicate-id" ? "first" : "second",
          });
        } else {
          definitions.push({
            id: "failure",
            agents: ["analyst"],
            create: () =>
              failure === "setup-failure"
                ? Effect.fail(new Error("Failed"))
                : Effect.succeed({
                    "run.before": () => Effect.fail(new Error("Failed")),
                  }),
          });
        }
        const exit = yield* execute(fixture.run).pipe(
          Effect.provide(PluginRegistry.layer(definitions)),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(fixture.calls).toEqual([]);
        const messages = (yield* fixture.session.listMessages({
          sessionID: fixture.run.sessionID,
          limit: 100,
        })).items;
        expect(
          messages.some((message) => message.info.role === "assistant"),
        ).toBe(false);
        if (failure === "unhandled" || failure.startsWith("duplicate-"))
          expect(messages).toEqual([]);
      }),
    );
  },
);
