import { unusedModelSetup } from "@openchart/server/models/models.test-utils";
// Purpose: Verifies first-turn title selection, normalization, persistence, and Effect failure boundaries.

import { Publisher } from "@openchart/server/agent/publisher/publisher";
import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import type { WithParts } from "@openchart/server/agent/contracts/message";
import type { AvailableModel } from "@openchart/models/model-provider";
import { TIER1 } from "@openchart/models/model-tiers";
import { LLM } from "@openchart/server/agent/llm";
import { RequestFailed } from "@openchart/server/agent/llm/errors";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Models } from "@openchart/server/models";
import { ModelNotFound } from "@openchart/server/models/errors";
import { assertExists } from "@openchart/utils/assert";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { SessionTitle } from "./title";

const model: AvailableModel = {
  id: "conversation",
  providerID: "openai",
  kind: "language",
  name: "Conversation",
  tier: 2,
  capabilities: { input: { text: true }, output: { text: true } },
};
const tierOne: AvailableModel = { ...model, id: "tier-one-native", tier: 1 };

type Requirements =
  | Publisher.Service
  | Session.Service
  | LLM.Service
  | Models.Service
  | AgentProfile.Service
  | Database.Service
  | Events.Service;
interface Fixture {
  input: Parameters<typeof SessionTitle.ensure>[0];
  message: WithParts;
  session: Session.Interface;
  calls: LLM.StreamInput<unknown, unknown>[];
  getModel: ReturnType<typeof vi.fn<Models.Interface["getModel"]>>;
  source: () => Stream.Stream<
    LLM.SuccessStreamEvent,
    LLM.LlmError,
    Database.Service | Events.Service | Publisher.Service
  >;
}

function request(fixture: Fixture) {
  const value = fixture.calls[0];
  assertExists(value, "Title inference was called");
  return value;
}

function run<A, E>(
  program: (fixture: Fixture) => Effect.Effect<A, E, Requirements>,
  options: {
    configuration?: AgentProfile.Configuration;
  } = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        const root = yield* session.create();
        const user = {
          id: "user",
          sessionID: root.id,
          role: "user" as const,
          time: { created: 1 },
          agent: "analyst",
          model: {
            providerID: model.providerID,
            modelID: model.id,
            selectedVariant: "high",
          },
        };
        const message: WithParts = {
          info: user,
          parts: [
            {
              id: "text",
              messageID: user.id,
              type: "text",
              text: "Track memory semiconductor supply bottlenecks",
            },
          ],
        };
        const fixture: Fixture = {
          session,
          message,
          input: {
            cwd: "/workspace/title",
            session: root,
            model,
            messages: [message],
          },
          calls: [],
          getModel: vi.fn((providerID, id) =>
            Effect.succeed(
              id === TIER1 ? tierOne : { ...model, providerID, id },
            ),
          ),
          source: () =>
            Stream.make({
              type: "text-delta",
              id: "title",
              text: "<think>hidden</think>\nNewsFeed query: semiconductor supply chain tracking",
            }),
        };
        const dependencies = yield* Effect.context<
          Database.Service | Events.Service | Publisher.Service
        >();
        return yield* program(fixture).pipe(
          Effect.provideService(LLM.Service, {
            stream: (request) => {
              fixture.calls.push(request);
              return fixture.source().pipe(Stream.provideContext(dependencies));
            },
          }),
          Effect.provideService(Models.Service, {
            ...unusedModelSetup,
            list: () =>
              Effect.die("Title resolves an explicit model reference"),
            getModel: fixture.getModel,
            getLanguage: () => Effect.die("Title only needs model metadata"),
          }),
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            Agui.layer.pipe(
              Layer.provideMerge(Session.layer),
              Layer.provideMerge(
                Layer.merge(
                  Database.layer(":memory:", () => Effect.void),
                  Events.layer,
                ),
              ),
            ),
            AgentProfile.layer(options.configuration ?? {}),
          ),
        ),
      ),
    ).pipe(Effect.provide(TestClock.layer())),
  );
}

test("uses the first real turn, explicit tier 1, and canonical normalized title", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const first = fixture.message;
      fixture.input.messages.unshift({
        info: { ...first.info, id: "synthetic" },
        parts: [
          {
            id: "synthetic-text",
            messageID: "synthetic",
            type: "text",
            text: "Earlier context",
            synthetic: true,
          },
        ],
      });
      yield* SessionTitle.ensure(fixture.input);
      expect(
        (yield* fixture.session.get(fixture.input.session.id))?.title,
      ).toBe("Semiconductor Supply Chain");
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.getModel).toHaveBeenCalledExactlyOnceWith(
        model.providerID,
        TIER1,
      );
      expect(request(fixture)).toMatchObject({
        model: tierOne,
        cwd: fixture.input.cwd,
        user: {
          id: "user",
          model: { providerID: "openai", modelID: tierOne.id },
        },
        retries: 2,
        tools: {},
      });
      expect(request(fixture).user.model.selectedVariant).toBeUndefined();
      expect(JSON.stringify(request(fixture).messages)).toContain(
        "Earlier context",
      );
    }),
  );
});

test("preserves the explicit title profile model", async () => {
  await run(
    (fixture) =>
      Effect.gen(function* () {
        yield* SessionTitle.ensure(fixture.input);
        expect(fixture.getModel).toHaveBeenCalledExactlyOnceWith(
          "claude-code",
          "tier3",
        );
        expect(request(fixture).user.model).toEqual({
          providerID: "claude-code",
          modelID: "tier3",
        });
      }),
    {
      configuration: {
        agents: {
          title: { model: { providerID: "claude-code", modelID: "tier3" } },
        },
      },
    },
  );
});

test("keeps the default title when the requested tier 1 is unavailable", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.getModel.mockImplementation((providerID, modelID) =>
        Effect.fail(
          new ModelNotFound({ providerID, modelID, cause: undefined }),
        ),
      );
      yield* SessionTitle.ensure(fixture.input);
      expect(fixture.getModel).toHaveBeenCalledExactlyOnceWith(
        model.providerID,
        TIER1,
      );
      expect(fixture.calls).toHaveLength(0);
      expect(
        (yield* fixture.session.get(fixture.input.session.id))?.title,
      ).toBe("New session");
    }),
  );
});

test.each([
  "parent",
  "delegate",
  "renamed",
  "synthetic",
  "second-turn",
  "empty",
])("skips title inference for %s input", async (kind) => {
  await run((fixture) =>
    Effect.gen(function* () {
      if (kind === "parent") fixture.input.session.parentId = "parent";
      if (kind === "delegate") fixture.input.session.kind = "delegate";
      if (kind === "renamed") fixture.input.session.title = "My title";
      if (kind === "synthetic") {
        fixture.message.parts = [
          {
            id: "part",
            messageID: "user",
            type: "text",
            text: "Go",
            synthetic: true,
          },
        ];
      }
      if (kind === "empty") fixture.message.parts = [];
      if (kind === "second-turn") {
        fixture.input.messages.push({
          ...fixture.message,
          info: { ...fixture.message.info, id: "second" },
        });
      }
      yield* SessionTitle.ensure(fixture.input);
      expect(fixture.calls).toHaveLength(0);
    }),
  );
});

test("uses subtask prompts directly and preserves a title edited during inference", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.message.parts = [
        {
          id: "task",
          messageID: "user",
          type: "subtask",
          prompt: "Track semiconductor supply",
          description: "Supply",
          agent: "analyst",
        },
      ] satisfies WithParts["parts"];
      fixture.source = () =>
        Stream.fromEffect(
          fixture.session
            .update(fixture.input.session.id, { title: "User title" })
            .pipe(
              Effect.orDie,
              Effect.as({
                type: "text-delta" as const,
                id: "title",
                text: "Generated",
              }),
            ),
        );
      yield* SessionTitle.ensure(fixture.input);
      expect(request(fixture).messages[1]).toEqual({
        role: "user",
        content: "Track semiconductor supply",
      });
      expect(
        (yield* fixture.session.get(fixture.input.session.id))?.title,
      ).toBe("User title");
    }),
  );
});

test("ignores expected model failures while preserving defects and interruption", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.source = () =>
        Stream.fail(new RequestFailed({ cause: "offline" }));
      expect(
        Exit.isSuccess(yield* Effect.exit(SessionTitle.ensure(fixture.input))),
      ).toBe(true);
      fixture.source = () => Stream.die("defect");
      const defect = yield* Effect.exit(SessionTitle.ensure(fixture.input));
      expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
      const started = yield* Deferred.make<void>();
      fixture.source = () =>
        Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        );
      const fiber = yield* Effect.forkChild(SessionTitle.ensure(fixture.input));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const interrupted = yield* Fiber.await(fiber);
      expect(
        Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause),
      ).toBe(true);
      expect(
        (yield* fixture.session.get(fixture.input.session.id))?.title,
      ).toBe("New session");
    }),
  );
});

test("times out stalled title inference without failing the prompt run", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      fixture.source = () =>
        Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              closed = true;
            }),
          ),
        );
      const fiber = yield* Effect.forkChild(SessionTitle.ensure(fixture.input));
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(fiber);
      expect(closed).toBe(true);
      expect(
        (yield* fixture.session.get(fixture.input.session.id))?.title,
      ).toBe("New session");
    }),
  );
});
