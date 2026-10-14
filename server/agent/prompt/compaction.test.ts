import { unusedModelSetup } from "@openchart/server/models/models.test-utils";
// Purpose: Verifies compaction success seals, failed summaries, and replay capacity checks.

import type {
  Assistant,
  User,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { ascending } from "@openchart/identifier";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session/session";
import { userMessageEvents } from "@openchart/server/agent/publisher/agui/projection";
import { Models } from "@openchart/server/models";
import { assertExists } from "@openchart/utils/assert";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { expect, test } from "vitest";
import {
  finish,
  finishStep,
  model,
  run,
  streamOf,
} from "@openchart/server/agent/processor/processor.test-utils";
import { compact, needsCompaction } from "./compaction";
import { nextDeterministicAction } from "./deterministic-action";
import { isUsableSummary, readHistory } from "./history";

const models = Models.Service.of({
  ...unusedModelSetup,
  list: () => Effect.succeed([]),
  getModel: () => Effect.succeed(model),
  getLanguage: () => Effect.die("Compaction tests use the LLM service"),
});

function userMessage(
  sessionID: string,
  text = "Analyze this context",
): WithParts & { info: User } {
  const info: User = {
    id: `msg_${ascending()}`,
    sessionID,
    role: "user",
    agent: "analyst",
    model: {
      providerID: model.providerID,
      modelID: model.id,
      selectedVariant: "high",
    },
    time: { created: 1 },
  };
  return {
    info,
    parts: [
      { id: `prt_${ascending()}`, messageID: info.id, type: "text", text },
    ],
  };
}

test("persists continuation before the usable summary seal and preserves the selected variant", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const user = userMessage(fixture.assistant.sessionID);
      yield* fixture.session.createMessage(user);
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "summary" },
          {
            type: "text-delta",
            id: "summary",
            text: "Continue analyzing the pending work.",
          },
          { type: "text-end", id: "summary" },
          finishStep(),
          finish,
        );
      yield* compact({
        messages: [user],
        user: user.info,
        model,
        cwd: "/workspace/compaction",
      });
      const history = yield* readHistory(user.info.sessionID);
      expect(history).toHaveLength(3);
      const [marker, summary, continuation] = history;
      const request = fixture.calls[0];
      assertExists(marker, "Compaction marker was not committed");
      assertExists(summary, "Compaction summary was not committed");
      assertExists(continuation, "Compaction continuation was not committed");
      assertExists(request, "Compaction request was not issued");
      expect(request.cwd).toBe("/workspace/compaction");
      expect(summary.info).toMatchObject({
        path: { cwd: request.cwd, root: request.cwd },
      });
      expect(marker.parts[0]?.type).toBe("compaction");
      expect(isUsableSummary(summary)).toBe(true);
      // The final seal is a live header update, not just a reload-only fact.
      expect(fixture.published.at(-1)).toMatchObject({
        type: "agent.event",
        data: {
          event: {
            type: "STATE_DELTA",
            delta: [
              {
                path: `/messageInfo/${summary.info.id}`,
                value: {
                  compaction: { userMessageId: marker.info.id, summary: true },
                },
              },
            ],
          },
        },
      });
      expect(continuation.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
      });
      expect(continuation.info).toMatchObject({
        agent: "analyst",
        model: user.info.model,
      });
      expect(request.tools).toEqual({});
      expect(request.agent.name).toBe("compaction");
      expect(request.user.model).toEqual(user.info.model);
      expect(summary.info).toMatchObject({
        request: { system: ["Prepared instructions"], tools: [] },
      });
      // The continuation appends natively to its Session; nothing replaces history.
      expect(
        fixture.published
          .filter((event) => {
            const native = (
              event.data as { event: { type: string; role?: string } }
            ).event;
            return (
              native.type === "TEXT_MESSAGE_START" && native.role === "user"
            );
          })
          .at(-1),
      ).toMatchObject({
        type: "agent.event",
        data: {
          sessionID: user.info.sessionID,
          event: userMessageEvents(continuation)[0],
        },
      });
      expect(
        fixture.published.some(
          (event) =>
            (event.data as { event: { type: string } }).event.type ===
            "MESSAGES_SNAPSHOT",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(AgentProfile.layerDefault),
      Effect.provideService(Models.Service, models),
    ),
  );
});

test("caps the summary request at the summary model's input budget", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const user = userMessage(fixture.assistant.sessionID, "x".repeat(20_000));
      yield* fixture.session.createMessage(user);
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "summary" },
          { type: "text-delta", id: "summary", text: "Summary." },
          { type: "text-end", id: "summary" },
          finishStep(),
          finish,
        );
      yield* compact({
        messages: [user],
        user: user.info,
        // 34k context minus 32k reserved output leaves 2k tokens (8k characters).
        model: { ...model, limit: { context: 34_000, output: 32_000 } },
        cwd: "/workspace",
      });
      const request = JSON.stringify(fixture.calls[0]?.messages);
      expect(request).toContain("[Middle of conversation truncated]");
      expect(request.length).toBeLessThan(10_000);
    }).pipe(
      Effect.provide(AgentProfile.layerDefault),
      Effect.provideService(Models.Service, models),
    ),
  );
});

test.each(["empty", "length"])(
  "%s compaction fails without creating a continuation or hiding source history",
  async (failure) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const user = userMessage(fixture.assistant.sessionID);
        yield* fixture.session.createMessage(user);
        fixture.source = () =>
          streamOf(
            { type: "start-step" },
            ...(failure === "length"
              ? [
                  { type: "text-start" as const, id: "summary" },
                  {
                    type: "text-delta" as const,
                    id: "summary",
                    text: "Truncated",
                  },
                  { type: "text-end" as const, id: "summary" },
                ]
              : []),
            finishStep(failure === "length" ? "length" : "stop"),
            finish,
          );
        const exit = yield* Effect.exit(
          compact({
            messages: [user],
            user: user.info,
            model,
            cwd: "/workspace/compaction",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasFails(exit.cause)).toBe(true);
        const history = yield* readHistory(user.info.sessionID);
        expect(
          history.some((message) => message.info.id === user.info.id),
        ).toBe(true);
        expect(history.some(isUsableSummary)).toBe(false);
        // Failed automatic summaries leave a marker, not a new explicit action.
        expect(
          yield* nextDeterministicAction({ messages: history, model }),
        ).toBeUndefined();
        expect(
          history.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.synthetic,
            ),
          ),
        ).toBe(false);
        const all = yield* fixture.session.listMessages({
          sessionID: user.info.sessionID,
          limit: 10,
        });
        const summary = all.items.find(
          (message) =>
            message.info.role === "assistant" &&
            message.info.agent === "compaction",
        );
        expect(summary?.info).toMatchObject({
          error: {
            name:
              failure === "length"
                ? "MessageOutputLengthError"
                : "UnknownError",
          },
        });
      }).pipe(
        Effect.provide(AgentProfile.layerDefault),
        Effect.provideService(Models.Service, models),
      ),
    );
  },
);

test("interrupted compaction keeps source history and persists unfinished summary cleanup", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const user = userMessage(fixture.assistant.sessionID);
      yield* fixture.session.createMessage(user);
      const waiting = yield* Deferred.make<void>();
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "summary" },
          { type: "text-delta", id: "summary", text: "Partial summary" },
        ).pipe(
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(waiting, undefined)).pipe(
              Stream.drain,
            ),
          ),
          Stream.concat(Stream.never),
        );
      const running = yield* Effect.forkChild(
        compact({
          messages: [user],
          user: user.info,
          model,
          cwd: "/workspace/compaction",
        }),
      );
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(running);
      const history = yield* readHistory(user.info.sessionID);
      expect(history.some((message) => message.info.id === user.info.id)).toBe(
        true,
      );
      expect(history.some(isUsableSummary)).toBe(false);
      const all = yield* fixture.session.listMessages({
        sessionID: user.info.sessionID,
        limit: 10,
      });
      const summary = all.items.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.agent === "compaction",
      );
      expect(summary?.info).toMatchObject({
        error: { name: "MessageAbortedError" },
      });
      expect(summary?.parts.find((part) => part.type === "text")).toMatchObject(
        {
          text: "Partial summary",
          time: { end: expect.any(Number) },
        },
      );
      expect(
        history.find((message) => message.info.id === summary?.info.id),
      ).toEqual({
        info: summary?.info,
        parts: [],
      });
    }).pipe(
      Effect.provide(AgentProfile.layerDefault),
      Effect.provideService(Models.Service, models),
    ),
  );
});

test("a failed final seal leaves the source history active after continuation is committed", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const user = userMessage(fixture.assistant.sessionID);
      yield* fixture.session.createMessage(user);
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "summary" },
          { type: "text-delta", id: "summary", text: "Completed summary" },
          { type: "text-end", id: "summary" },
          finishStep(),
          finish,
        );
      const interruptedSeal: Session.Interface = {
        ...fixture.session,
        updateMessage: (info) =>
          info.role === "assistant" && info.summary
            ? Effect.die("Simulated failed summary seal")
            : fixture.session.updateMessage(info),
      };
      const exit = yield* Effect.exit(
        compact({
          messages: [user],
          user: user.info,
          model,
          cwd: "/workspace/compaction",
        }).pipe(Effect.provideService(Session.Service, interruptedSeal)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const history = yield* readHistory(user.info.sessionID);
      expect(history.some((message) => message.info.id === user.info.id)).toBe(
        true,
      );
      expect(history.some(isUsableSummary)).toBe(false);
      expect(history.at(-1)?.parts[0]).toMatchObject({
        text: "Continue if you have next steps",
      });
    }).pipe(
      Effect.provide(AgentProfile.layerDefault),
      Effect.provideService(Models.Service, models),
    ),
  );
});

test("overflow uses replayed context, available input capacity, and a completed non-summary step", async () => {
  const user = userMessage("session", "x".repeat(8_000));
  const assistant: Assistant = {
    id: "assistant",
    sessionID: "session",
    role: "assistant",
    triggeringUserMessageID: user.info.id,
    agent: "analyst",
    modelID: model.id,
    providerID: model.providerID,
    path: { cwd: "/", root: "/" },
    time: { created: 2 },
    finish: "tool-calls",
    cost: 0,
    tokens: {
      input: 1_000_000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  const messages: WithParts[] = [user, { info: assistant, parts: [] }];
  const limited = { ...model, limit: { context: 34_000, output: 32_000 } };
  expect(await Effect.runPromise(needsCompaction(messages, limited))).toBe(
    true,
  );
  expect(await Effect.runPromise(needsCompaction([user], limited))).toBe(false);
  expect(await Effect.runPromise(needsCompaction(messages, model))).toBe(false);
  expect(
    await Effect.runPromise(
      needsCompaction(messages, {
        ...limited,
        limit: { ...limited.limit, input: 10_000 },
      }),
    ),
  ).toBe(false);
  expect(
    await Effect.runPromise(
      needsCompaction(
        [user, { info: { ...assistant, summary: true }, parts: [] }],
        limited,
      ),
    ),
  ).toBe(false);
  expect(
    await Effect.runPromise(
      needsCompaction(
        [
          { ...user, parts: [] },
          { info: assistant, parts: [] },
        ],
        limited,
      ),
    ),
  ).toBe(false);
});

test.each(["content", "attachment"])(
  "media in tool %s counts its framing without charging base64 bytes as prompt text",
  async (source) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const user = userMessage(fixture.assistant.sessionID);
        const encoded = "a".repeat(1_000_000);
        const tool: ToolPart = {
          id: "tool",
          messageID: fixture.assistant.id,
          type: "tool",
          childSessionIds: [],
          tool: "echo",
          callID: "media",
          state: {
            status: "completed",
            input: {},
            title: "Media result",
            metadata: {},
            time: { start: 1, end: 2 },
            output:
              source === "content"
                ? {
                    type: "content",
                    value: [
                      { type: "media", mediaType: "image/png", data: encoded },
                    ],
                  }
                : { type: "text", value: "See the attached image" },
            ...(source === "attachment"
              ? {
                  attachments: [
                    {
                      id: "image",
                      messageID: fixture.assistant.id,
                      type: "file" as const,
                      mime: "image/png",
                      url: `data:image/png;base64,${encoded}`,
                    },
                  ],
                }
              : {}),
          },
        };
        expect(
          yield* needsCompaction(
            [
              user,
              {
                info: { ...fixture.assistant, finish: "tool-calls" },
                parts: [tool],
              },
            ],
            { ...model, limit: { context: 34_000, output: 32_000 } },
          ),
        ).toBe(false);
      }),
    );
  },
);
