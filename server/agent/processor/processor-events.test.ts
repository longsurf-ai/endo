// Purpose: Verifies the emitted transcript protocol through actual Event subscribers and SQLite replay.

import type { Assistant } from "@openchart/server/agent/contracts/message";
import { Session as SessionInfo } from "@openchart/server/agent/contracts/session";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import { projectTranscript } from "@openchart/server/agent/publisher/agui/projection";
import { projectMessageInfo } from "@openchart/server/agent/publisher/agui/state";
import {
  projectTree,
  readTree,
} from "@openchart/server/agent/publisher/agui/subagents";
import { RequestFailed } from "@openchart/server/agent/llm/errors";
import { Session } from "@openchart/server/agent/session/session";
import { EventDefinition } from "@openchart/server/events";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { from } from "rxjs";
import { Processor } from "./processor";
import {
  finish,
  finishStep,
  model,
  run,
  streamOf,
  type Fixture,
} from "./processor.test-utils";

const TranscriptEvent = AgentEvent;
type TranscriptEvent = typeof TranscriptEvent.Type;
const CaptureFinished = EventDefinition.define({
  type: "test.processor.capture-finished",
  schema: {},
});

// Observe the actual PubSub delivery. The sentinel drains preceding envelopes
// without sleep-based assumptions about the subscriber fiber's scheduling.
function capture<A, E, R>(fixture: Fixture, action: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const received: TranscriptEvent[] = [];
    const drained = yield* Deferred.make<void>();
    const live = yield* fixture.events.allBounded(256);
    const observer = yield* live.pipe(
      Stream.runForEach((event) =>
        event.type === CaptureFinished.type
          ? Deferred.succeed(drained, undefined)
          : Effect.sync(() => {
              received.push(Schema.decodeUnknownSync(TranscriptEvent)(event));
            }),
      ),
      Effect.forkScoped,
    );
    const result = yield* Effect.exit(action);
    yield* fixture.events.publish(CaptureFinished, {});
    yield* Deferred.await(drained);
    yield* Fiber.interrupt(observer);
    expect(received).toEqual(fixture.published);
    expect(new Set(received.map((event) => event.id)).size).toBe(
      received.length,
    );
    for (const event of received) expect(event.id).toMatch(/^evt_/);
    return { received, result };
  }).pipe(Effect.scoped);
}

// Use the public community reducer, including its protocol verifier. Only the
// The existing trigger supplies initial client state; subsequent changes come from events.
function verifyReplay(fixture: Fixture, events: TranscriptEvent[]) {
  return Effect.gen(function* () {
    for (const sessionID of new Set(
      events.map((event) => event.data.sessionID),
    )) {
      const trigger =
        sessionID === fixture.assistant.sessionID
          ? yield* fixture.session.getMessage({
              sessionID,
              messageID: fixture.assistant.triggeringUserMessageID,
            })
          : undefined;
      const initial = trigger ? [trigger] : [];
      const failed = events
        .filter((event) => event.data.sessionID === sessionID)
        .flatMap(sourceInfo)
        .some((info) => info.error !== undefined);
      const native: AGUIEvent[] = [
        { type: EventType.RUN_STARTED, threadId: sessionID, runId: "test-run" },
        {
          type: EventType.STATE_SNAPSHOT,
          snapshot: { messageInfo: projectMessageInfo(initial) },
        },
        ...events
          .filter((event) => event.data.sessionID === sessionID)
          .map((event) => event.data.event),
        failed
          ? { type: EventType.RUN_ERROR, message: "Processor failed" }
          : {
              type: EventType.RUN_FINISHED,
              threadId: sessionID,
              runId: "test-run",
            },
      ];
      const agent = new (class extends AbstractAgent {
        /** Supplies committed native events. @example agent.run(); */
        run() {
          return from(native);
        }
      })({ threadId: sessionID, initialMessages: projectTranscript(initial) });
      yield* Effect.promise(() => agent.runAgent({ runId: "test-run" }));
      const history = yield* fixture.session.listMessages({
        sessionID,
        limit: 100,
      });
      expect(history.nextCursor).toBeNull();
      const projected = projectTree(
        sessionID,
        yield* readTree(
          yield* fixture.session.readTranscriptPage({
            sessionID,
            turnLimit: Number.MAX_SAFE_INTEGER,
          }),
        ),
      );
      // Concurrent invocations can interleave; order within each invocation is
      // canonical, while the native attribution keeps their contents separate.
      for (const owner of new Set(
        projected.messages.map((message) => message.subagentRunId),
      ))
        expect(
          agent.messages.filter((message) => message.subagentRunId === owner),
        ).toEqual(
          projected.messages.filter(
            (message) => message.subagentRunId === owner,
          ),
        );
      expect(agent.messages).toHaveLength(projected.messages.length);
      expect(agent.state.messageInfo).toEqual(projected.messageInfo);
    }
  });
}

type SourceInfo = {
  messageId: string;
  completedAt?: Assistant["time"]["completed"];
  error?: Assistant["error"];
};

function sourceInfo({ data: { event } }: TranscriptEvent): SourceInfo[] {
  if (event.type !== EventType.STATE_DELTA || event.subagentRunId !== undefined)
    return [];
  return event.delta.flatMap((patch) => {
    if (!patch.path.startsWith("/messageInfo/")) return [];
    const source = patch.value as {
      completedAt: number | null;
      error: Assistant["error"] | null;
    };
    return [
      {
        messageId: patch.path.slice("/messageInfo/".length),
        completedAt: source.completedAt ?? undefined,
        error: source.error ?? undefined,
      },
    ];
  });
}

test.each([
  { reason: "stop" as const, failed: false, completed: [0] },
  { reason: "tool-calls" as const, failed: false, completed: [1_000] },
  { reason: "stop" as const, failed: true, completed: [0, 1_000] },
])(
  "root finalization preserves committed completion (reason=$reason, failed=$failed)",
  async ({ reason, failed, completed }) => {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.source = () =>
          streamOf(
            { type: "start-step" },
            { type: "text-start", id: "terminal" },
            { type: "text-end", id: "terminal" },
            finishStep(reason),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(TestClock.adjust(1_000)).pipe(Stream.drain),
            ),
            Stream.concat(
              failed
                ? Stream.fail(
                    new RequestFailed({ cause: new Error("Provider failed") }),
                  )
                : streamOf(finish),
            ),
          );
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        const { received, result } = yield* capture(
          fixture,
          processor.process(fixture.request),
        );
        expect(Exit.isFailure(result)).toBe(failed);
        const terminal = received
          .flatMap(sourceInfo)
          .filter((info) => info.completedAt !== undefined);
        expect(terminal.map((message) => message.completedAt)).toEqual(
          completed,
        );
        expect(terminal.at(-1)?.error !== undefined).toBe(failed);
        yield* verifyReplay(fixture, received);
      }),
    );
  },
);

test("committed text uses native deltas and end events without a trimming snapshot", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", text: "Hello " },
          { type: "text-delta", id: "text", text: "world  " },
          { type: "text-end", id: "text" },
          finishStep(),
          finish,
        );
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      const { received, result } = yield* capture(
        fixture,
        processor.process(fixture.request),
      );
      expect(Exit.isSuccess(result)).toBe(true);
      expect(received.map(({ data }) => data.event.type)).toEqual([
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.STATE_DELTA,
      ]);
      const deltas = received.flatMap(({ data: { event } }) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT ? [event] : [],
      );
      expect(deltas.map((event) => event.delta)).toEqual(["Hello", " world"]);
      expect(new Set(deltas.map((event) => event.messageId)).size).toBe(1);
      const saved = yield* fixture.session.getMessage({
        sessionID: fixture.assistant.sessionID,
        messageID: fixture.assistant.id,
      });
      expect(saved?.info).toHaveProperty("request.system", [
        "Prepared instructions",
      ]);
      expect(saved?.info).toMatchObject({
        finish: "stop",
        tokens: { input: 10, output: 5, reasoning: 2 },
      });
      yield* verifyReplay(fixture, received);
    }),
  );
});

test("text and reasoning with the same model id publish independent Part identities", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "shared" },
          { type: "reasoning-start", id: "shared" },
          { type: "text-delta", id: "shared", text: "Answer" },
          { type: "reasoning-delta", id: "shared", text: "Reasoning" },
          { type: "reasoning-end", id: "shared" },
          { type: "text-end", id: "shared" },
          finishStep(),
          finish,
        );
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      const { received } = yield* capture(
        fixture,
        processor.process(fixture.request),
      );
      const content = received.flatMap(({ data: { event } }) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT ||
        event.type === EventType.REASONING_MESSAGE_CONTENT
          ? [event]
          : [],
      );
      expect(content.map((event) => [event.type, event.delta])).toEqual([
        [EventType.TEXT_MESSAGE_CONTENT, "Answer"],
        [EventType.REASONING_MESSAGE_CONTENT, "Reasoning"],
      ]);
      expect(new Set(content.map((event) => event.messageId)).size).toBe(2);
      yield* verifyReplay(fixture, received);
    }),
  );
});

test.each([false, true])(
  "tool events preserve transitions and final output (providerExecuted=%s)",
  async (providerExecuted) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        const rawOutput = { symbols: ["AAPL", "MSFT"] };
        fixture.source = () =>
          Stream.concat(
            streamOf(
              { type: "start-step" },
              { type: "tool-input-start", id: "call", toolName: "lookup" },
              {
                type: "tool-call",
                toolCallId: "call",
                toolName: "lookup",
                input: { query: "AAPL" },
                providerExecuted,
              },
            ),
            Stream.concat(
              Stream.fromEffect(
                processor.updateToolProgress("call", {
                  title: "Searching",
                  metadata: { count: 1 },
                }),
              ).pipe(Stream.orDie, Stream.drain),
              streamOf(
                {
                  type: "tool-result",
                  toolCallId: "call",
                  toolName: "lookup",
                  input: { query: "AAPL" },
                  ...(providerExecuted
                    ? {
                        providerExecuted: true as const,
                        output: { output: rawOutput, attachments: [] },
                      }
                    : {
                        output: {
                          title: "Lookup complete",
                          metadata: { count: 2 },
                          output: { type: "json" as const, value: rawOutput },
                        },
                      }),
                },
                finishStep(),
                finish,
              ),
            ),
          );
        const { received, result } = yield* capture(
          fixture,
          processor.process(fixture.request),
        );
        expect(Exit.isSuccess(result)).toBe(true);
        const tools = received.flatMap(({ data: { event } }) =>
          event.type === EventType.TOOL_CALL_START ||
          event.type === EventType.TOOL_CALL_ARGS ||
          event.type === EventType.TOOL_CALL_END ||
          event.type === EventType.TOOL_CALL_RESULT
            ? [event]
            : [],
        );
        expect(tools.map((event) => event.type)).toEqual([
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
        ]);
        expect(new Set(tools.map((event) => event.toolCallId))).toEqual(
          new Set(["call"]),
        );
        const activities = received.flatMap(({ data: { event } }) =>
          event.type === EventType.ACTIVITY_SNAPSHOT ||
          event.type === EventType.ACTIVITY_DELTA
            ? [event]
            : [],
        );
        expect(activities[0]).toMatchObject({
          type: EventType.ACTIVITY_SNAPSHOT,
          content: { toolCallId: "call", status: "pending" },
        });
        expect(
          activities.some(
            (event) =>
              event.type === EventType.ACTIVITY_DELTA &&
              event.patch.some(
                (patch) =>
                  patch.path === "/title" && patch.value === "Searching",
              ),
          ),
        ).toBe(true);
        expect(
          received.some(
            ({ data: { event } }) => event.type === EventType.MESSAGES_SNAPSHOT,
          ),
        ).toBe(false);
        expect(tools.at(-1)).toMatchObject({
          content: JSON.stringify(rawOutput),
        });
        yield* verifyReplay(fixture, received);
      }),
    );
  },
);

test("delegate events establish the child before its Parts and finish it before the proxy", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const inDelegate = { openchart: { delegateCallId: "delegate" } };
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "tool-input-start", id: "delegate", toolName: "Agent" },
          {
            type: "tool-call",
            toolCallId: "delegate",
            toolName: "Agent",
            input: {},
            providerExecuted: true,
            providerMetadata: {
              openchart: {
                openDelegate: {
                  agent: "Explore",
                  description: "Inspect",
                  prompt: "Inspect the data",
                },
              },
            },
          },
          { type: "start-step", providerMetadata: inDelegate },
          { type: "text-start", id: "child", providerMetadata: inDelegate },
          {
            type: "text-delta",
            id: "child",
            text: "Child answer",
            providerMetadata: inDelegate,
          },
          { type: "text-end", id: "child", providerMetadata: inDelegate },
          { ...finishStep(), providerMetadata: inDelegate },
          {
            type: "tool-result",
            toolCallId: "delegate",
            toolName: "Agent",
            input: {},
            output: { output: "Proxy result", attachments: [] },
            providerExecuted: true,
          },
          finishStep(),
          finish,
        );
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      const { received, result } = yield* capture(
        fixture,
        processor.process(fixture.request),
      );
      expect(Exit.isSuccess(result)).toBe(true);
      const createdIndex = received.findIndex(
        ({ data: { event } }) =>
          event.type === EventType.STATE_DELTA &&
          event.delta.some((patch) => patch.path === "/session"),
      );
      const created = received[createdIndex]?.data.event;
      expect(created?.type).toBe(EventType.STATE_DELTA);
      if (created?.type !== EventType.STATE_DELTA)
        throw new Error("Child session was not published");
      const child = Schema.decodeUnknownSync(SessionInfo)(
        created.delta.find((patch) => patch.path === "/session")?.value,
      );
      expect(child.parentId).toBe(fixture.assistant.sessionID);
      const firstChildInput = received.findIndex(
        ({ data }) =>
          data.sessionID === child.id &&
          data.event.type === EventType.TEXT_MESSAGE_START &&
          data.event.role === "user",
      );
      expect(firstChildInput).toBeGreaterThan(createdIndex);
      expect(
        received.some(
          ({ data: { event } }) =>
            (event.type === EventType.ACTIVITY_SNAPSHOT &&
              event.content.childSessionId === child.id) ||
            (event.type === EventType.ACTIVITY_DELTA &&
              event.patch.some(
                (patch) =>
                  patch.path === "/childSessionId" && patch.value === child.id,
              )),
        ),
      ).toBe(true);
      const childFinish = received.findIndex(
        (event) =>
          event.data.sessionID === child.id &&
          sourceInfo(event).some((info) => info.completedAt !== undefined),
      );
      const proxyFinish = received.findIndex(
        ({ data: { event } }) => event.type === EventType.TOOL_CALL_RESULT,
      );
      expect(childFinish).toBeGreaterThan(-1);
      expect(childFinish).toBeLessThan(proxyFinish);
      yield* verifyReplay(fixture, received);
    }),
  );
});

test.each(["error", "cancel"] as const)(
  "terminal %s flushes an event-replayable transcript without session.error",
  async (outcome) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        fixture.source = () =>
          Stream.concat(
            streamOf(
              { type: "start-step" },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", text: "Partial  " },
            ),
            Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
              Stream.drain,
              Stream.concat(
                outcome === "error"
                  ? Stream.fail(
                      new RequestFailed({
                        cause: new Error("Provider failed"),
                      }),
                    )
                  : Stream.never,
              ),
            ),
          );
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        const action =
          outcome === "error"
            ? processor.process(fixture.request)
            : Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  processor.process(fixture.request),
                );
                yield* Deferred.await(entered);
                yield* Fiber.interrupt(fiber);
                return yield* Fiber.join(fiber);
              });
        const { received, result } = yield* capture(fixture, action);
        expect(Exit.isFailure(result)).toBe(true);
        if (outcome === "cancel" && Exit.isFailure(result))
          expect(Cause.hasInterrupts(result.cause)).toBe(true);
        expect(received.map(({ data }) => data.event.type)).toEqual([
          EventType.STEP_STARTED,
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.STATE_DELTA,
        ]);
        const last = received.at(-1);
        expect(last?.data.event.type).toBe(EventType.STATE_DELTA);
        if (last)
          expect(sourceInfo(last)[0]).toMatchObject({
            error: {
              name:
                outcome === "error" ? "UnknownError" : "MessageAbortedError",
            },
            completedAt: expect.any(Number),
          });
        yield* verifyReplay(fixture, received);
      }),
    );
  },
);

test("a failed commit publishes no successful completion and cleanup events match surviving storage", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const broken: Session.Interface = {
        ...fixture.session,
        finishStep: () => Effect.die("Commit rejected"),
      };
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      }).pipe(Effect.provideService(Session.Service, broken));
      const { received, result } = yield* capture(
        fixture,
        processor.process(fixture.request),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(received.map(({ data }) => data.event.type)).toEqual([
        EventType.STEP_STARTED,
        EventType.STATE_DELTA,
      ]);
      yield* verifyReplay(fixture, received);
    }),
  );
});

test("failure publishes child terminal headers before the root completion signal", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const inDelegate = { openchart: { delegateCallId: "delegate" } };
      fixture.source = () =>
        Stream.concat(
          streamOf(
            { type: "start-step" },
            { type: "tool-input-start", id: "delegate", toolName: "Agent" },
            {
              type: "tool-call",
              toolCallId: "delegate",
              toolName: "Agent",
              input: {},
              providerExecuted: true,
              providerMetadata: {
                openchart: {
                  openDelegate: {
                    agent: "Explore",
                    description: "Inspect",
                    prompt: "Inspect the data",
                  },
                },
              },
            },
            { type: "start-step", providerMetadata: inDelegate },
            { type: "text-start", id: "child", providerMetadata: inDelegate },
            {
              type: "text-delta",
              id: "child",
              text: "Partial child",
              providerMetadata: inDelegate,
            },
          ),
          Stream.fail(
            new RequestFailed({ cause: new Error("Provider failed") }),
          ),
        );
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      const { received, result } = yield* capture(
        fixture,
        processor.process(fixture.request),
      );
      expect(Exit.isFailure(result)).toBe(true);
      const terminal = received
        .flatMap(sourceInfo)
        .filter((info) => info.completedAt !== undefined);
      expect(terminal).toHaveLength(2);
      expect(terminal[0]?.messageId).not.toBe(fixture.assistant.id);
      expect(terminal[1]?.messageId).toBe(fixture.assistant.id);
      expect(
        received.filter(
          ({ data }) => data.event.type === EventType.SUBAGENT_ERROR,
        ),
      ).toHaveLength(1);
      expect(
        received.some(
          ({ data }) => data.event.type === EventType.SUBAGENT_FINISHED,
        ),
      ).toBe(false);
      expect(sourceInfo(received.at(-1)!)).toMatchObject([
        { messageId: fixture.assistant.id },
      ]);
      yield* verifyReplay(fixture, received);
    }),
  );
});
