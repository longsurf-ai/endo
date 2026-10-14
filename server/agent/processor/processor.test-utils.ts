// Purpose: Shares real in-memory Session fixtures for processor behavior tests.

import { Publisher } from "@openchart/server/agent/publisher/publisher";
import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import type { Assistant } from "@openchart/server/agent/contracts/message";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import type { AvailableModel } from "@openchart/models/model-provider";
import { LLM } from "@openchart/server/agent/llm/llm";
import { assertExists } from "@openchart/utils/assert";
import { Session } from "@openchart/server/agent/session/session";
import { Database } from "@openchart/server/db";
import { Models } from "@openchart/server/models";
import { modelTestDependencies } from "@openchart/server/models/models.test-utils";
import { EventDefinition, Events } from "@openchart/server/events";
import { Context, Effect, Layer, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

/** Catalog metadata with nonzero rates for transcript cost assertions. */
export const model = {
  id: "processor-test",
  providerID: "openai",
  name: "Processor test",
  kind: "language",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
  },
  cost: {
    input: 1,
    output: 2,
    cache: { read: 0.1, write: 0.5 },
    contextTiers: [],
  },
} satisfies AvailableModel;

const usage = {
  inputTokens: 15,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
  totalTokens: 20,
};

/**
 * Constructs a canonical finish-step event with known input/cache/output usage.
 * @example
 * const events = streamOf({type: 'start-step'}, finishStep());
 */
export function finishStep(
  finishReason: Extract<
    LLM.SuccessStreamEvent,
    { type: "finish-step" }
  >["finishReason"] = "stop",
): Extract<LLM.SuccessStreamEvent, { type: "finish-step" }> {
  return { type: "finish-step", finishReason, usage };
}

/** Final request event, whose usage is deliberately not added a second time. */
export const finish: LLM.SuccessStreamEvent = {
  type: "finish",
  finishReason: "stop",
  rawFinishReason: undefined,
  totalUsage: usage,
};

/**
 * Emits model events individually, preserving consumer commit ordering.
 * @example
 * fixture.source = () => streamOf({type: 'start-step'}, finishStep(), finish);
 */
export function streamOf(...events: LLM.SuccessStreamEvent[]) {
  return Stream.fromIterable(events);
}

/** Real persistence and injectable provider events, isolated to one test. */
export interface Fixture {
  readonly session: Session.Interface;
  readonly events: Events.Interface;
  readonly assistant: Assistant;
  readonly request: LLM.StreamInput;
  readonly calls: LLM.StreamInput<unknown, unknown>[];
  readonly published: EventDefinition.Payload[];
  /**
   * Supplies the next model stream after request-snapshot persistence.
   * @example
   * fixture.source = () => Stream.fail(new RequestFailed({cause}));
   */
  source: <R>(
    request: LLM.StreamInput<unknown, R>,
  ) => Stream.Stream<
    LLM.SuccessStreamEvent,
    LLM.LlmError,
    R | Database.Service | Events.Service | Publisher.Service
  >;
}

/**
 * Reads a tool's committed state through the public Session API without waiting.
 * @example
 * const part = yield* readToolPart(fixture, 'call-1');
 */
export const readToolPart = Effect.fn(function* (
  fixture: Fixture,
  callID: string,
) {
  const message = yield* fixture.session.getMessage({
    sessionID: fixture.assistant.sessionID,
    messageID: fixture.assistant.id,
  });
  const part = message?.parts.find(
    (part): part is ToolPart => part.type === "tool" && part.callID === callID,
  );
  assertExists(part, `No committed ToolPart for ${callID}`);
  return part;
});

/**
 * Runs with real Session operations over an isolated SQLite database and TestClock.
 * The mock LLM preserves lazy consumption and typed request-snapshot failures.
 * @example
 * await run(fixture => Effect.gen(function* () {
 *   const processor = yield* Processor.create({assistantMessage: fixture.assistant, model});
 *   yield* processor.process(fixture.request);
 * }));
 */
export function run<A, E>(
  program: (
    fixture: Fixture,
  ) => Effect.Effect<
    A,
    E,
    | Session.Service
    | LLM.Service
    | Models.Service
    | Database.Service
    | Events.Service
    | Publisher.Service
  >,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dependencies = yield* Layer.build(
          Layer.mergeAll(
            Database.layer(":memory:", () => Effect.void),
            Events.layer,
            Models.layer({
              runtimeDirectory: "/unused/providers",
              cacheDirectory: "/unused/models",
              fetchEnabled: false,
              userAgent: "test",
            }).pipe(Layer.provide(modelTestDependencies)),
          ),
        );
        const events = Context.get(dependencies, Events.Service);
        const published: EventDefinition.Payload[] = [];
        const checked: Events.Interface = {
          ...events,
          publish: (definition, data, options) =>
            events.publish(definition, data, options).pipe(
              Effect.tap((event) =>
                Effect.sync(() => {
                  published.push(event);
                }),
              ),
            ),
        };
        return yield* Effect.gen(function* () {
          const session = yield* Session.Service;
          const root = yield* session.create();
          yield* session.createMessage({
            info: {
              // Preserve trigger order when SQL creation timestamps tie.
              id: "0-user",
              sessionID: root.id,
              role: "user",
              time: { created: 1 },
              agent: "analyst",
              model: { providerID: model.providerID, modelID: model.id },
              workspaceId: "wsp_processor",
            },
            parts: [],
          });
          const assistant: Assistant = {
            id: "assistant",
            sessionID: root.id,
            role: "assistant",
            time: { created: 1 },
            triggeringUserMessageID: "0-user",
            agent: "analyst",
            providerID: model.providerID,
            modelID: model.id,
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          };
          yield* session.createMessage({ info: assistant, parts: [] });
          published.length = 0;
          const fixture: Fixture = {
            session,
            events,
            assistant,
            published,
            calls: [],
            request: {
              model,
              cwd: "/tmp",
              user: {
                id: "0-user",
                model: { providerID: model.providerID, modelID: model.id },
              },
              sessionID: root.id,
              agent: { name: "analyst", prompt: "Analyze", options: {} },
              system: [],
              messages: [],
              tools: {},
            },
            source: () =>
              streamOf({ type: "start-step" }, finishStep(), finish),
          };
          const publisher = yield* Publisher.Service;
          const llm: LLM.Interface = {
            stream: (request) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  fixture.calls.push(request);
                  if (request.recordRequestSnapshot) {
                    yield* request.recordRequestSnapshot({
                      system: ["Prepared instructions"],
                      tools: [],
                    });
                  }
                  return fixture
                    .source(request)
                    .pipe(
                      Stream.provideContext(
                        Context.add(dependencies, Events.Service, checked),
                      ),
                      Stream.provideService(Publisher.Service, publisher),
                      Stream.provideService(Scope.Scope, yield* Effect.scope),
                    );
                }),
              ),
          };
          return yield* program(fixture).pipe(
            Effect.provideService(LLM.Service, llm),
          );
        }).pipe(
          Effect.provide(Layer.fresh(Agui.layer)),
          Effect.provide(Session.layer),
          Effect.provide(Context.add(dependencies, Events.Service, checked)),
        );
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
}
