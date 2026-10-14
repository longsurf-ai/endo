// Purpose: Locks invocation isolation, ordered context preparation, hook failures, and cancellation.

import {
  PluginContext,
  AgentPluginId,
} from "@openchart/server/agent/contracts/part";
import { Context, Deferred, Effect, Exit, Fiber, Scope, Schema } from "effect";
import { expect, test } from "vitest";
import { Plugin } from "./plugin";
import { HookFailed } from "./errors";

const pluginContext = (content: string, pluginId = "context") =>
  Schema.decodeUnknownSync(PluginContext)({
    kind: "plugin",
    pluginId,
    hook: "run.before",
    content,
  });

const invocation: Plugin.Invocation = {
  runID: "run",
  sessionID: "session",
  triggerMessageID: "trigger",
  agent: "test",
  pluginInputs: [],
  model: { providerID: "test", modelID: "test" },
};

const prepare = Effect.gen(function* () {
  const plugins = yield* Plugin.Service;
  return yield* plugins.trigger("run.before");
});

test("provides independent invocation state to the same lifecycle consumer", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const definition: Plugin.Definition = {
          id: "context",
          agents: ["test"],
          create: (invocation) =>
            Effect.sync(() => {
              let count = 0;
              return {
                "run.before": () =>
                  Effect.sync(() => [
                    pluginContext(`${invocation.runID}:${++count}`),
                  ]),
              };
            }),
        };
        const first = yield* Plugin.create([definition], invocation);
        const second = yield* Plugin.create([definition], {
          ...invocation,
          runID: "other",
        });
        const results = yield* Effect.gen(function* () {
          return [
            yield* prepare,
            yield* prepare.pipe(Effect.provideService(Plugin.Service, second)),
            yield* prepare,
          ];
        }).pipe(Effect.provideService(Plugin.Service, first));
        expect(results.map((result) => result[0]?.content)).toEqual([
          "run:1",
          "other:1",
          "run:2",
        ]);
      }),
    ),
  );
});

test("binds required services while keeping factory finalizers in each invocation scope", async () => {
  class Source extends Context.Service<Source, { text: string }>()(
    "Test.Plugin.Source",
  ) {}
  const released: string[] = [];
  const definition = {
    id: "context",
    agents: ["test"],
    create: (input: typeof invocation) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released.push(input.runID);
          }),
        );
        return {
          "run.before": () =>
            Source.use((source) =>
              Effect.succeed([pluginContext(source.text)]),
            ),
        };
      }),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const definitionScope = yield* Scope.make();
        const bound = yield* Plugin.bind(definition).pipe(
          Effect.provideService(Source, { text: "captured" }),
          Scope.provide(definitionScope),
        );
        yield* Scope.close(definitionScope, Exit.void);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const plugins = yield* Plugin.create([bound], invocation);
            expect(released).toEqual([]);
            expect(
              yield* prepare.pipe(
                Effect.provideService(Plugin.Service, plugins),
              ),
            ).toEqual([pluginContext("captured")]);
          }),
        );
        expect(released).toEqual(["run"]);
      }),
    ),
  );
});

test("attributes expected failures and cancels non-abortable preparation", async () => {
  const cause = new Error("lookup failed");
  const released: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plugins = yield* Plugin.create(
          [
            {
              id: "failed",
              agents: ["test"],
              create: () =>
                Effect.succeed({
                  "run.before": () => Effect.fail(cause),
                }),
            },
          ],
          invocation,
        );
        const exit = yield* Effect.exit(
          prepare.pipe(Effect.provideService(Plugin.Service, plugins)),
        );
        expect(exit).toMatchObject({
          cause: {
            reasons: [
              {
                error: new HookFailed({
                  pluginID: "failed",
                  hook: "run.before",
                  runID: "run",
                  triggerMessageID: "trigger",
                  cause,
                }),
              },
            ],
          },
        });
        const started = yield* Deferred.make<void>();
        const pending = yield* Effect.scoped(
          Effect.gen(function* () {
            const plugins = yield* Plugin.create(
              [
                {
                  id: "waiting",
                  agents: ["test"],
                  create: () =>
                    Effect.gen(function* () {
                      yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                          released.push("waiting");
                        }),
                      );
                      return {
                        "run.before": () =>
                          Deferred.succeed(started, undefined).pipe(
                            Effect.andThen(
                              Effect.promise(
                                () => new Promise<never>(() => {}),
                              ),
                            ),
                          ),
                      };
                    }),
                },
              ],
              invocation,
            );
            yield* prepare.pipe(Effect.provideService(Plugin.Service, plugins));
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(pending);
        expect(released).toEqual(["waiting"]);
      }),
    ),
  );
});

test("retains frozen invocation facts and detaches ordered contexts", async () => {
  const order: string[] = [];
  const context = pluginContext("Original");
  const source = {
    ...invocation,
    model: { ...invocation.model },
    pluginInputs: [{ type: "alert_trigger" as const, eventId: "original" }],
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plugins = yield* Plugin.create(
          ["first", "second"].map((id) => ({
            id,
            agents: ["test"],
            create: (input) =>
              Effect.succeed({
                "run.before": () =>
                  Effect.sync(() => {
                    order.push(id);
                    expect(input.model.modelID).toBe("test");
                    expect(input.pluginInputs[0]).toEqual({
                      type: "alert_trigger",
                      eventId: "original",
                    });
                    expect(Reflect.set(input.model, "modelID", id)).toBe(false);
                    expect(
                      Reflect.set(input.pluginInputs[0]!, "eventId", id),
                    ).toBe(false);
                    expect(Object.isFrozen(input.pluginInputs)).toBe(true);
                    if (id === "second") context.content = "Changed";
                    context.pluginId =
                      Schema.decodeUnknownSync(AgentPluginId)(id);
                    return [context];
                  }),
              }),
          })),
          source,
        );
        source.model.modelID = "Changed after creation";
        source.pluginInputs[0]!.eventId = "Changed after creation";
        const result = yield* prepare.pipe(
          Effect.provideService(Plugin.Service, plugins),
        );
        context.content = "After dispatch";
        expect(source.model.modelID).toBe("Changed after creation");
        expect(order).toEqual(["first", "second"]);
        expect(result).toEqual([
          pluginContext("Original", "first"),
          pluginContext("Changed", "second"),
        ]);
      }),
    ),
  );
});
