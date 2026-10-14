import { DEFAULT_HISTORY_TURN_LIMIT } from "@openchart/server/agent/session/operations/read-transcript-page";
import { QueryClient } from "@tanstack/react-query";
// Purpose: Verifies real HTTP recovery and native AG-UI reduction against canonical SQLite state.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { once } from "node:events";
import { createServer } from "node:http";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { createAgentClient } from "@openchart/app/lib/agent/client";
import { createSessionStore } from "@openchart/app/lib/agent/session-store";
import { createTransport } from "@openchart/app/lib/transport/transport";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AvailableModel } from "@openchart/models/model-provider";
import { mockModels } from "@openchart/server/models/models.test-utils";
import { router, createRequestHandler } from "@openchart/server";
import { Session } from "@openchart/server/agent/session";
import { Events } from "@openchart/server/events";
import { makeRuntime } from "@openchart/server/runtime";
import { createTRPCClient, httpLink } from "@trpc/client";
import { simulateReadableStream } from "ai";
import { EventSource } from "eventsource";
import { from, Subject } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";

import { projectTranscript } from "./publisher/agui/projection";
import { projectState } from "./publisher/agui/state";

const model = AvailableModel.parse({
  kind: "language",
  providerID: "openai",
  id: "test-model",
  name: "Test",
  tier: 1,
  capabilities: {
    toolcall: true,
    input: { text: true },
    output: { text: true },
  },
  limit: { context: 200_000, output: 16_384 },
});
const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 6, text: 4, reasoning: 2 },
  },
};
const partial: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: "Hello\n" },
  { type: "text-delta", id: "answer", delta: "Grüße 🌊" },
];
const tool: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "reasoning-start", id: "reason" },
  { type: "reasoning-delta", id: "reason", delta: "Call Echo." },
  { type: "reasoning-end", id: "reason" },
  { type: "tool-input-start", id: "echo-call", toolName: "echo" },
  { type: "tool-input-delta", id: "echo-call", delta: '{"text":"Grüße 🌊"}' },
  { type: "tool-input-end", id: "echo-call" },
  {
    type: "tool-call",
    toolCallId: "echo-call",
    toolName: "echo",
    input: '{"text":"Grüße 🌊"}',
  },
  { ...finish, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
];

class Observer extends AbstractAgent {
  run() {
    return from<AGUIEvent[]>([]);
  }
  observe(events: Subject<AGUIEvent>) {
    const input = this.prepareRunAgentInput();
    return this.processApplyEvents(
      input,
      this.apply(input, events, this.subscribers),
      this.subscribers,
    );
  }
}

afterEach(() => vi.restoreAllMocks());

test.each([
  "tool",
  "error",
  "cancel",
  "queued",
  "reconnect",
  "approve",
  "reject",
  "cancel-approval",
] as const)(
  "SSE and the community reducer recover after %s and another turn",
  async (outcome) => {
    const asks = ["approve", "reject", "cancel-approval"].includes(outcome);
    let continueStream: () => void = () => {
      throw new Error("Stream not started");
    };
    const doStream = vi
      .fn<LanguageModelV4["doStream"]>(async () => ({
        stream: simulateReadableStream({
          chunks: [...partial, { type: "text-end", id: "answer" }, finish],
        }),
      }))
      .mockImplementationOnce(async (options) => {
        if (outcome === "tool" || asks)
          return { stream: simulateReadableStream({ chunks: tool }) };
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              for (const part of partial) controller.enqueue(part);
              continueStream = () =>
                controller.enqueue({
                  type: "text-delta",
                  id: "answer",
                  delta: " again",
                });
              if (outcome === "error") {
                controller.enqueue({
                  type: "error",
                  error: new Error("Offline"),
                });
                controller.close();
              } else
                options.abortSignal?.addEventListener(
                  "abort",
                  () => controller.close(),
                  { once: true },
                );
            },
          }),
        };
      });
    const language: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: model.providerID,
      modelId: model.id,
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream,
    };
    mockModels(model, language);
    const runtime = makeRuntime({
      home: temporaryHome(),
      databasePath: ":memory:",
      ...(asks
        ? {
            profiles: {
              agents: {
                analyst: {
                  permission: [
                    { action: "echo", resource: "*", decision: "ask" },
                  ],
                },
              },
            },
          }
        : {}),
    });
    let connections = 0;
    const handler = createRequestHandler(runtime);
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/trpc/events.subscribe")) connections++;
      handler(request, response);
    });
    const cleanup: (() => void)[] = [];
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No TCP port");
      const url = `http://127.0.0.1:${address.port}/trpc`;
      const client = createTRPCClient<typeof router>({
        links: [httpLink({ url })],
      });
      const remote = createAgentClient(
        createTransport(
          { origin: `http://127.0.0.1:${address.port}` },
          { EventSource },
        ),
      );
      const session = await client.agent.createSession.mutate({
        title: "SSE test",
      });
      const other = await client.agent.createSession.mutate({
        title: "Independent",
      });
      const open = async (sessionID: string) => {
        const events: AGUIEvent[] = [];
        const failures: unknown[] = [];
        const subject = new Subject<AGUIEvent>();
        const agent = new Observer({ threadId: sessionID });
        agent.subscribe({
          onMessagesSnapshotEvent: ({ event }) => ({
            messages: structuredClone(event.messages),
            stopPropagation: true,
          }),
        });
        const reduction = agent
          .observe(subject)
          .subscribe({ error: (error) => failures.push(error) });
        const subscription = remote.observe(sessionID).subscribe({
          next: (native) => {
            events.push(native);
            subject.next(native);
          },
          error: (error) => failures.push(error),
        });
        const close = () => {
          subscription.unsubscribe();
          reduction.unsubscribe();
          subject.complete();
        };
        cleanup.push(close);
        await expect.poll(() => agent.state.session?.id).toBe(sessionID);
        return { agent, events, failures, close };
      };
      const first = await open(session.id);
      const independent = await open(other.id);
      expect(connections).toBe(1);
      expect(first.agent.messages).toEqual([]);
      const submit = (intent: string) =>
        client.agent.prompt.mutate({
          sessionID: session.id,
          sessionIntentID: intent,
          input: {
            agent: "analyst",
            model: { providerID: "codex" as const, modelID: "tier1" as const },
            parts: [{ type: "text", text: `Hello\nGrüße 🌊 ${intent}` }],
          },
        });
      const accepted = await submit("first");
      expect(accepted.status).toBe("queued");
      let late: Awaited<ReturnType<typeof open>> | undefined;
      let queued: Awaited<ReturnType<typeof submit>> | undefined;
      if (asks) {
        await expect.poll(() => first.agent.state.permissions?.length).toBe(1);
        late = await open(session.id);
        expect(late.agent.state.permissions).toEqual(
          first.agent.state.permissions,
        );
        if (outcome === "cancel-approval")
          await client.agent.cancel.mutate({ sessionID: session.id });
        else
          await client.agent.replyPermission.mutate({
            requestID: first.agent.state.permissions[0].id,
            reply: outcome === "approve" ? "once" : "reject",
          });
      } else if (
        outcome === "cancel" ||
        outcome === "queued" ||
        outcome === "reconnect"
      ) {
        await expect
          .poll(() =>
            first.agent.messages.some(
              (message) => message.content === "Hello\nGrüße 🌊",
            ),
          )
          .toBe(true);
        expect((await remote.listSessions()).items).toContainEqual(
          expect.objectContaining({ id: session.id, isActive: true }),
        );
        await expect(
          client.agent.truncateSession.mutate({
            sessionID: session.id,
            messageID: null,
          }),
        ).rejects.toMatchObject({ data: { code: "CONFLICT" } });
        if (outcome === "queued") queued = await submit("second");
        if (outcome === "reconnect") {
          server.closeAllConnections();
          late = first;
        } else {
          first.close();
          late = await open(session.id);
        }
        expect(
          late.agent.messages.filter(
            (message) => message.content === "Hello\nGrüße 🌊",
          ),
        ).toHaveLength(1);
        continueStream();
        await expect
          .poll(
            () =>
              late?.agent.messages.some(
                (message) => message.content === "Hello\nGrüße 🌊 again",
              ),
            { timeout: 7_000 },
          )
          .toBe(true);
        await client.agent.cancel.mutate({ sessionID: session.id });
      }
      const current = late ?? first;
      const expected =
        outcome === "error" || outcome === "reject"
          ? "failed"
          : outcome === "tool" || outcome === "approve"
            ? "completed"
            : "stop";
      await expect
        .poll(
          () =>
            current.agent.state.runs?.find(
              (run: { id: string }) => run.id === accepted.id,
            )?.status,
        )
        .toBe(expected);
      if (expected !== "failed") {
        await expect
          .poll(() =>
            current.events.some(
              (event) =>
                event.type === EventType.RUN_FINISHED &&
                event.runId === accepted.id,
            ),
          )
          .toBe(true);
        expect(
          current.events.some((event) => event.type === EventType.RUN_ERROR),
        ).toBe(false);
      }
      await expect.poll(() => current.agent.state.permissions).toEqual([]);
      const second = queued ?? (await submit("second"));
      await expect
        .poll(
          () =>
            current.agent.state.runs?.find(
              (run: { id: string }) => run.id === second.id,
            )?.status,
        )
        .toBe("completed");
      expect((await remote.listSessions()).items).toContainEqual(
        expect.objectContaining({ id: session.id, isActive: false }),
      );
      const canonical = await runtime.runPromise(
        Events.Service.use((events) =>
          events.withBarrier(
            Session.Service.use((sessions) =>
              sessions.readSnapshot(session.id),
            ),
          ),
        ),
      );
      const snapshot = {
        messages: projectTranscript(canonical.history),
        state: projectState(
          canonical.history,
          canonical.state,
          canonical.nextCursor,
        ),
      };
      await expect
        .poll(() => current.agent.messages)
        .toEqual(snapshot.messages);
      expect(current.agent.state).toEqual(snapshot.state);
      expect(
        snapshot.messages.filter((message) => message.role === "user"),
      ).toHaveLength(Math.min(2, DEFAULT_HISTORY_TURN_LIMIT));
      expect(independent.agent.messages).toEqual([]);
      expect(independent.agent.state.runs).toEqual([]);
      const persisted = await runtime.runPromise(
        Session.Service.use((sessions) =>
          sessions.listMessages({ sessionID: session.id, limit: 100 }),
        ),
      );
      expect(
        persisted.items.filter(({ info }) => info.role === "user"),
      ).toHaveLength(2);
      const displayed = await remote.readTranscriptPage({
        sessionID: session.id,
      });
      expect(displayed.messages).toEqual(snapshot.messages);
      // The stock client also verifies the actual run's native event ordering.
      if (outcome === "tool" || outcome === "approve") {
        const start = first.events.findIndex(
          (event) => event.type === EventType.RUN_STARTED,
        );
        const end = first.events.findIndex(
          (event) => event.type === EventType.RUN_FINISHED,
        );
        const nativeRun = first.events.slice(start, end + 1);
        // The complete user input appends natively; nothing replaces history.
        expect(
          nativeRun.filter(
            (event) => event.type === EventType.MESSAGES_SNAPSHOT,
          ),
        ).toHaveLength(0);
        expect(
          nativeRun.filter(
            (event) =>
              event.type === EventType.TEXT_MESSAGE_START &&
              event.role === "user",
          ),
        ).toHaveLength(1);
        const replay = new (class extends AbstractAgent {
          run() {
            return from(nativeRun);
          }
        })({ threadId: session.id });
        await replay.runAgent();
        expect(replay.messages.some((message) => message.role === "tool")).toBe(
          true,
        );
      }
      const reopened = await open(session.id);
      expect(reopened.agent.messages).toEqual(snapshot.messages);
      expect(connections).toBe(outcome === "reconnect" ? 2 : 1);
      if (outcome === "tool") {
        const firstReply = persisted.items.find(
          ({ info }) => info.role === "assistant" && info.finish === "stop",
        )!;
        const boundary = persisted.items.indexOf(firstReply);
        const selectedPart = firstReply.parts.find(
          (part) => part.type === "text",
        )!;
        const digInInput = {
          sessionID: session.id,
          messageID: firstReply.info.id,
          selection: {
            partId: selectedPart.id,
            text: "Grüße 🌊",
            startOffset: 6,
            endOffset: 14,
          },
        };
        for (const selection of [
          { ...digInInput.selection, text: " " },
          { ...digInInput.selection, startOffset: -1 },
          { ...digInInput.selection, startOffset: 14 },
          { ...digInInput.selection, endOffset: 6 },
        ])
          await expect(
            client.agent.digInSession.mutate({ ...digInInput, selection }),
          ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
        const child = await client.agent.digInSession.mutate(digInInput);
        const anotherChild = await client.agent.digInSession.mutate(digInInput);
        expect(anotherChild.id).not.toBe(child.id);
        await expect
          .poll(() => current.agent.state.session.anchors)
          .toEqual([
            {
              ...digInInput.selection,
              childSessionId: child.id,
            },
            {
              ...digInInput.selection,
              childSessionId: anotherChild.id,
            },
          ]);
        const digging = await open(child.id);
        expect(digging.agent.messages).toEqual([]);
        expect(digging.agent.state.runs).toEqual([]);
        const question = {
          sessionID: child.id,
          sessionIntentID: "dig-in-question",
          input: {
            agent: "analyst",
            model: { providerID: "codex" as const, modelID: "tier1" as const },
            parts: [{ type: "text" as const, text: "Explain this selection" }],
          },
        };
        const diggingRun = await remote.prompt(question);
        expect((await remote.prompt(question)).id).toBe(diggingRun.id);
        await expect
          .poll(
            () =>
              digging.agent.state.runs?.find(
                (item: { id: string }) => item.id === diggingRun.id,
              )?.status,
          )
          .toBe("completed");
        expect(
          digging.agent.messages.filter((message) => message.role === "user"),
        ).toHaveLength(1);
        const digInPrompt = JSON.stringify(
          doStream.mock.calls.at(-1)![0].prompt,
        );
        expect(digInPrompt).toContain("The user opened this Dig In");
        expect(digInPrompt).toContain("Hello\\nGrüße 🌊 first");
        expect(digInPrompt).not.toContain("Grüße 🌊 second");
        const diggingSnapshot = await runtime.runPromise(
          Session.Service.use((sessions) => sessions.readSnapshot(child.id)),
        );
        expect(digging.agent.messages).toEqual(
          projectTranscript(diggingSnapshot.history),
        );
        const digReply = diggingSnapshot.history.at(-1)!;
        await expect(
          client.agent.digInSession.mutate({
            ...digInInput,
            sessionID: child.id,
            messageID: digReply.info.id,
            selection: {
              ...digInInput.selection,
              partId: digReply.parts.find((part) => part.type === "text")!.id,
            },
          }),
        ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
        digging.close();
        const reopenedDigIn = await open(child.id);
        expect(reopenedDigIn.agent.messages).toEqual(digging.agent.messages);
        expect(reopenedDigIn.agent.state.session).toMatchObject({
          id: child.id,
          parentId: session.id,
          kind: "dig_in",
        });
        expect(digging.failures).toEqual([]);
        expect(reopenedDigIn.failures).toEqual([]);
        expect(current.agent.messages).toEqual(snapshot.messages);

        const branch = await remote.forkSession({
          sessionID: session.id,
          messageID: firstReply.info.id,
        });
        expect(
          (await remote.listSessions()).items.map(({ id }) => id),
        ).toContain(branch.id);
        const forked = await open(branch.id);
        expect(forked.agent.state.runs).toEqual([]);
        expect(forked.agent.state.permissions).toEqual([]);
        const branchHistory = await runtime.runPromise(
          Session.Service.use((sessions) =>
            sessions.readTranscriptPage({
              sessionID: branch.id,
              turnLimit: Number.MAX_SAFE_INTEGER,
            }),
          ),
        );
        expect(branchHistory.history).toHaveLength(boundary + 1);
        expect(forked.agent.messages).toEqual(
          projectTranscript(branchHistory.history),
        );
        const run = await remote.prompt({
          sessionID: branch.id,
          sessionIntentID: "branch-continue",
          input: {
            agent: "analyst",
            model: { providerID: "codex" as const, modelID: "tier1" as const },
            parts: [{ type: "text", text: "Continue branch" }],
          },
        });
        await expect
          .poll(
            () =>
              forked.agent.state.runs?.find(
                (item: { id: string }) => item.id === run.id,
              )?.status,
          )
          .toBe("completed");
        expect(JSON.stringify(doStream.mock.calls.at(-1)![0].prompt)).toContain(
          "Hello\\nGrüße 🌊 first",
        );
        expect(
          JSON.stringify(doStream.mock.calls.at(-1)![0].prompt),
        ).not.toContain("Grüße 🌊 second");
        expect(current.agent.messages).toEqual(snapshot.messages);
        forked.close();
        const restored = await open(branch.id);
        expect(restored.agent.messages).toEqual(forked.agent.messages);
        await expect(
          remote.forkSession({
            sessionID: other.id,
            messageID: firstReply.info.id,
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
        const userMessage = canonical.history[0]!;
        await expect(
          remote.forkSession({
            sessionID: session.id,
            messageID: userMessage.info.id,
          }),
        ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

        await expect(
          client.agent.truncateSession.mutate({
            sessionID: child.id,
            messageID: null,
          }),
        ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
        await expect(
          client.agent.truncateSession.mutate({
            sessionID: other.id,
            messageID: firstReply.info.id,
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
        for (const messageID of ["", userMessage.info.id])
          await expect(
            client.agent.truncateSession.mutate({
              sessionID: session.id,
              messageID,
            }),
          ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

        const callsBeforeTruncate = doStream.mock.calls.length;
        const runsBeforeTruncate = structuredClone(current.agent.state.runs);
        // The App's existing snapshot subscriber replaces full history; the bare
        // SDK reducer intentionally retains omitted reasoning/activity messages.
        const store = createSessionStore(
          remote,
          new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        );
        cleanup.push(() => store.dispose());
        const handle = store.getSession(session.id);
        cleanup.push(handle.subscribe(() => {}));
        await expect.poll(() => handle.getSnapshot().loading).toBe(false);
        await client.agent.truncateSession.mutate({
          sessionID: session.id,
          messageID: firstReply.info.id,
        });
        const truncated = await runtime.runPromise(
          Session.Service.use((sessions) => sessions.readSnapshot(session.id)),
        );
        expect(truncated.history).toEqual(
          persisted.items.slice(0, boundary + 1),
        );
        await expect
          .poll(() => current.agent.messages)
          .toEqual(projectTranscript(truncated.history));
        await expect
          .poll(() => handle.getSnapshot().messages)
          .toEqual(projectTranscript(truncated.history));
        await expect
          .poll(() => current.agent.state)
          .toEqual(projectState(truncated.history, truncated.state));
        expect(current.agent.state.runs).toEqual(runsBeforeTruncate);
        expect(doStream).toHaveBeenCalledTimes(callsBeforeTruncate);
        const afterTruncate = await open(session.id);
        expect(afterTruncate.agent.messages).toEqual(current.agent.messages);
        expect(afterTruncate.agent.state).toEqual(current.agent.state);

        const edited = await client.agent.prompt.mutate({
          sessionID: session.id,
          sessionIntentID: "edited-second",
          input: {
            agent: "analyst",
            model: { providerID: "codex" as const, modelID: "tier1" as const },
            parts: [{ type: "text", text: "Edited question" }],
          },
        });
        await expect
          .poll(
            () =>
              current.agent.state.runs?.find(
                (item: { id: string }) => item.id === edited.id,
              )?.status,
          )
          .toBe("completed");
        const editedPrompt = JSON.stringify(
          doStream.mock.calls.at(-1)![0].prompt,
        );
        expect(editedPrompt).toContain("Edited question");
        expect(editedPrompt).toContain("Grüße 🌊 first");
        expect(editedPrompt).not.toContain("Grüße 🌊 second");

        await client.agent.truncateSession.mutate({
          sessionID: session.id,
          messageID: null,
        });
        await expect.poll(() => handle.getSnapshot().messages).toEqual([]);
        await expect.poll(() => current.agent.state.messageInfo).toEqual({});
        await expect
          .poll(() => current.agent.state.session.anchors)
          .toEqual([]);
        const cleared = await open(session.id);
        expect(cleared.agent.messages).toEqual([]);
        expect(cleared.agent.state).toEqual(handle.getSnapshot().state);
        expect(independent.agent.messages).toEqual([]);
        for (const observer of [afterTruncate, cleared])
          expect(observer.failures).toEqual([]);
      }
      for (const observer of [first, current, independent, reopened])
        expect(observer.failures).toEqual([]);
    } finally {
      for (const close of cleanup) close();
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await runtime.dispose();
    }
  },
  15_000,
);
