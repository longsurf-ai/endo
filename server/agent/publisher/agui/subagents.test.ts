import { QueryClient } from "@tanstack/react-query";
// Purpose: Verifies native nested/parallel delegate rendering through real persistence and the community client.

import { AbstractAgent } from "@ag-ui/client";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { createSessionStore } from "@openchart/app/lib/agent/session-store";
import type { LLM } from "@openchart/server/agent/llm/llm";
import { RequestFailed } from "@openchart/server/agent/llm/errors";
import { Processor } from "@openchart/server/agent/processor/processor";
import { Session } from "@openchart/server/agent/session";
import {
  finish,
  finishStep,
  model,
  run,
  streamOf,
} from "@openchart/server/agent/processor/processor.test-utils";
import { Effect, Schema, Stream } from "effect";
import { from, Subject } from "rxjs";
import { expect, test, vi } from "vitest";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import {
  projectTree,
  readTree,
} from "@openchart/server/agent/publisher/agui/subagents";

function ownedBy(id?: string) {
  return id === undefined ? undefined : { openchart: { delegateCallId: id } };
}

function start(id: string, parent?: string): LLM.SuccessStreamEvent[] {
  return [
    {
      type: "tool-input-start",
      id,
      toolName: "Agent",
      providerMetadata: ownedBy(parent),
    },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "Agent",
      input: {},
      providerExecuted: true,
      providerMetadata: {
        openchart: {
          delegateCallId: parent,
          openDelegate: { agent: id, description: id, prompt: `Task ${id}` },
        },
      },
    },
    { type: "start-step", providerMetadata: ownedBy(id) },
    { type: "text-start", id: `${id}-text`, providerMetadata: ownedBy(id) },
    {
      type: "text-delta",
      id: `${id}-text`,
      text: `${id}: first`,
      providerMetadata: ownedBy(id),
    },
  ];
}

function end(id: string, parent?: string): LLM.SuccessStreamEvent[] {
  return [
    {
      type: "text-delta",
      id: `${id}-text`,
      text: " second",
      providerMetadata: ownedBy(id),
    },
    { type: "text-end", id: `${id}-text`, providerMetadata: ownedBy(id) },
    { ...finishStep(), providerMetadata: ownedBy(id) },
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "Agent",
      input: {},
      output: { output: `Result ${id}`, attachments: [] },
      providerExecuted: true,
      providerMetadata: ownedBy(parent),
    },
  ];
}

test.each(["success", "failure"])(
  "parallel nested children converge after mid-stream bootstrap and cold reload: %s",
  async (outcome) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const rootID = fixture.assistant.sessionID;
        let initial: ReturnType<typeof projectTree> | undefined;
        let offset = 0;
        fixture.source = () =>
          streamOf(
            { type: "start-step" },
            ...start("alpha"),
            ...start("beta"),
            ...start("nested", "alpha"),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.gen(function* () {
                  initial = projectTree(
                    rootID,
                    yield* readTree(
                      yield* fixture.session
                        .readTranscriptPage({
                          sessionID: rootID,
                          turnLimit: Number.MAX_SAFE_INTEGER,
                        })
                        .pipe(Effect.orDie),
                    ).pipe(
                      Effect.provideService(Session.Service, fixture.session),
                    ),
                  );
                  offset = fixture.published.length;
                }),
              ).pipe(Stream.drain),
            ),
            Stream.concat(
              outcome === "failure"
                ? Stream.fail(
                    new RequestFailed({ cause: new Error("Connection lost") }),
                  )
                : streamOf(
                    ...end("beta"),
                    ...end("nested", "alpha"),
                    ...end("alpha"),
                    finishStep(),
                    finish,
                  ),
            ),
          );
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        yield* processor.process(fixture.request).pipe(Effect.exit);
        const rootEvents = (offset = 0) =>
          fixture.published
            .slice(offset)
            .filter((event) => event.type === AgentEvent.type)
            .map((event) => Schema.decodeUnknownSync(AgentEvent)(event))
            .filter((event) => event.data.sessionID === rootID)
            .map((event) => event.data.event);
        const completed = projectTree(
          rootID,
          yield* readTree(
            yield* fixture.session
              .readTranscriptPage({
                sessionID: rootID,
                turnLimit: Number.MAX_SAFE_INTEGER,
              })
              .pipe(Effect.orDie),
          ),
        );
        const native: AGUIEvent[] = [
          { type: EventType.RUN_STARTED, threadId: rootID, runId: "run" },
          { type: EventType.STATE_SNAPSHOT, snapshot: { messageInfo: {} } },
          ...rootEvents(),
          outcome === "failure"
            ? { type: EventType.RUN_ERROR, message: "Connection lost" }
            : { type: EventType.RUN_FINISHED, threadId: rootID, runId: "run" },
        ];
        const verified = new (class extends AbstractAgent {
          /** Runs the real projected events through the native verifier. @example agent.run(); */
          run() {
            return from(native);
          }
        })({ threadId: rootID });
        yield* Effect.promise(() => verified.runAgent());
        expect(
          native.filter((event) => event.type === EventType.SUBAGENT_STARTED),
        ).toHaveLength(3);
        expect(
          native.filter(
            (event) =>
              event.type ===
              (outcome === "failure"
                ? EventType.SUBAGENT_ERROR
                : EventType.SUBAGENT_FINISHED),
          ),
        ).toHaveLength(3);
        const starts = native.filter(
          (event) => event.type === EventType.SUBAGENT_STARTED,
        );
        for (const start of starts)
          expect(
            native
              .filter(
                (event) =>
                  ((event.type === EventType.TOOL_CALL_START ||
                    event.type === EventType.TOOL_CALL_RESULT) &&
                    event.toolCallId === start.parentToolCallId) ||
                  ((event.type === EventType.SUBAGENT_STARTED ||
                    event.type === EventType.SUBAGENT_FINISHED ||
                    event.type === EventType.SUBAGENT_ERROR) &&
                    event.subagentRunId === start.subagentRunId),
              )
              .map((event) => event.type),
          ).toEqual([
            EventType.TOOL_CALL_START,
            EventType.SUBAGENT_STARTED,
            outcome === "failure"
              ? EventType.SUBAGENT_ERROR
              : EventType.SUBAGENT_FINISHED,
            EventType.TOOL_CALL_RESULT,
          ]);
        const alpha = starts.find(
          (event) => event.parentToolCallId === "alpha",
        )!;
        const nested = starts.find(
          (event) => event.parentToolCallId === "nested",
        )!;
        const ends = native.filter(
          (event) =>
            event.type === EventType.SUBAGENT_ERROR ||
            event.type === EventType.SUBAGENT_FINISHED,
        );
        expect(
          ends.findIndex(
            (event) => event.subagentRunId === nested.subagentRunId,
          ),
        ).toBeLessThan(
          ends.findIndex(
            (event) => event.subagentRunId === alpha.subagentRunId,
          ),
        );
        expect(initial).toBeDefined();

        yield* Effect.promise(async () => {
          const streams: Subject<AGUIEvent>[] = [];
          const store = createSessionStore(
            {
              transport: { url: "test" },
              readTranscriptPage: async () => {
                throw new Error("Observation only");
              },
              observe: () => {
                const stream = new Subject<AGUIEvent>();
                streams.push(stream);
                return stream;
              },
              prompt: async () => {
                throw new Error("Observation only");
              },
              renameSession: async () => {
                throw new Error("Observation only");
              },
              cancel: async () => {
                throw new Error("Observation only");
              },
              replyQuestion: async () => {
                throw new Error("unused");
              },
              replyPermission: async () => {
                throw new Error("Observation only");
              },
            },
            new QueryClient(),
          );
          try {
            const session = store.getSession(rootID);
            let detach = session.subscribe(() => {});
            const sendSnapshot = (projection: NonNullable<typeof initial>) => {
              const events: AGUIEvent[] = [
                {
                  type: EventType.MESSAGES_SNAPSHOT,
                  messages: projection.messages,
                },
                {
                  type: EventType.STATE_SNAPSHOT,
                  snapshot: {
                    messageInfo: projection.messageInfo,
                    history: { nextCursor: null },
                  },
                },
                ...projection.lifecycle,
                ...projection.open,
              ];
              events.forEach((event) => streams.at(-1)!.next(event));
            };
            sendSnapshot(initial!);
            rootEvents(offset).forEach((event) => streams.at(-1)!.next(event));
            await vi.waitFor(() =>
              expect(
                Object.values(session.getSnapshot().subagents).filter(
                  (child) => child.end,
                ),
              ).toHaveLength(3),
            );
            const live = session.getSnapshot();
            expect(
              live.messages.filter(
                (message) =>
                  message.subagentRunId !== undefined &&
                  message.role === "assistant" &&
                  message.content,
              ),
            ).toHaveLength(3);
            detach();
            detach = session.subscribe(() => {});
            sendSnapshot(completed);
            await vi.waitFor(() =>
              expect(
                Object.values(session.getSnapshot().subagents).filter(
                  (child) => child.end,
                ),
              ).toHaveLength(3),
            );
            await vi.waitFor(() => {
              const cold = session.getSnapshot();
              expect(cold.subagents).toEqual(live.subagents);
              for (const owner of [undefined, ...Object.keys(live.subagents)])
                expect(
                  cold.messages.filter(
                    (message) => message.subagentRunId === owner,
                  ),
                ).toEqual(
                  live.messages.filter(
                    (message) => message.subagentRunId === owner,
                  ),
                );
            });
            expect(session.getSnapshot().error).toBeUndefined();
            detach();
          } finally {
            store.dispose();
          }
        });
      }),
    );
  },
);
