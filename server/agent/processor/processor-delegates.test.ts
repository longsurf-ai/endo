// Purpose: Verifies delegate routing, lifecycle ordering, and cleanup through real Session persistence.

import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { LLM } from "@openchart/server/agent/llm/llm";
import { RequestFailed } from "@openchart/server/agent/llm/errors";
import { Session } from "@openchart/server/agent/session/session";
import { Cause, Effect, Exit, Stream } from "effect";
import { expect, test } from "vitest";
import { Processor } from "./processor";
import {
  finish,
  finishStep,
  model,
  run,
  streamOf,
} from "./processor.test-utils";

function ownedBy(callID: string) {
  return { openchart: { delegateCallId: callID } };
}

function proxy(
  callID: string,
  parent: string | null = null,
): LLM.SuccessStreamEvent[] {
  return [
    {
      type: "tool-input-start",
      id: callID,
      toolName: "Agent",
      providerExecuted: true,
      providerMetadata: parent === null ? undefined : ownedBy(parent),
    },
    {
      type: "tool-call",
      toolCallId: callID,
      toolName: "Agent",
      input: {},
      providerExecuted: true,
      providerMetadata: {
        openchart: {
          ...(parent === null ? {} : { delegateCallId: parent }),
          openDelegate: {
            description: `Inspect ${callID}`,
            prompt: `Read ${callID}`,
            agent: "Explore",
          },
        },
      },
    },
  ];
}

function result(
  callID: string,
  parent: string | null = null,
): LLM.SuccessStreamEvent {
  return {
    type: "tool-result",
    toolCallId: callID,
    toolName: "Agent",
    input: {},
    output: { output: "Proxy response is not child text", attachments: [] },
    providerExecuted: true,
    providerMetadata: parent === null ? undefined : ownedBy(parent),
  };
}

test("projects nested delegates with independent transcripts, usage, and proxy relationships", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const a = ownedBy("a");
      const b = ownedBy("b");
      fixture.source = () =>
        streamOf(
          { type: "start-step" },
          { type: "text-start", id: "root-text" },
          { type: "text-delta", id: "root-text", text: "Root answer" },
          ...proxy("a"),
          { type: "start-step", providerMetadata: a },
          ...proxy("b", "a"),
          { type: "start-step", providerMetadata: b },
          { type: "text-start", id: "child-text", providerMetadata: b },
          {
            type: "text-delta",
            id: "child-text",
            text: "Child B answer",
            providerMetadata: b,
          },
          { type: "text-end", id: "child-text", providerMetadata: b },
          { ...finishStep("tool-calls"), providerMetadata: b },
          result("b", "a"),
          { ...finishStep(), providerMetadata: a },
          result("a"),
          { type: "text-end", id: "root-text" },
          finishStep(),
          finish,
        );
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      expect(yield* processor.process(fixture.request)).toBeUndefined();
      const root = yield* fixture.session.getMessage({
        sessionID: fixture.assistant.sessionID,
        messageID: fixture.assistant.id,
      });
      const rootProxy = root?.parts.find(
        (part): part is ToolPart => part.type === "tool",
      );
      expect(rootProxy).toMatchObject({
        callID: "a",
        state: { status: "completed" },
      });
      const aID = rootProxy!.childSessionIds[0]!;
      const aSession = yield* fixture.session.get(SessionId.make(aID));
      expect(aSession).toMatchObject({
        parentId: fixture.assistant.sessionID,
        kind: "delegate",
      });
      const aMessages = (yield* fixture.session.listMessages({
        sessionID: aID,
        limit: 10,
      })).items;
      const aAssistant = aMessages.find(
        (message) => message.info.role === "assistant",
      )!;
      const aUser = aMessages.find((message) => message.info.role === "user")!;
      expect(aUser.parts).toEqual([
        expect.objectContaining({ type: "text", text: "Read a" }),
      ]);
      expect(aAssistant.info).toMatchObject({
        triggeringUserMessageID: aUser.info.id,
        agent: "analyst",
        providerID: model.providerID,
        modelID: model.id,
        path: fixture.assistant.path,
      });
      expect(aAssistant.parts.some((part) => part.type === "text")).toBe(false);
      const nested = aAssistant.parts.find(
        (part): part is ToolPart => part.type === "tool",
      )!;
      const bID = nested.childSessionIds[0]!;
      expect(yield* fixture.session.get(SessionId.make(bID))).toMatchObject({
        parentId: aID,
        kind: "delegate",
      });
      const bMessages = (yield* fixture.session.listMessages({
        sessionID: bID,
        limit: 10,
      })).items;
      const bAssistant = bMessages.find(
        (message) => message.info.role === "assistant",
      )!;
      expect(
        bMessages.find((message) => message.info.role === "user")?.info,
      ).toMatchObject({ workspaceId: "wsp_processor" });
      expect(bAssistant.parts.filter((part) => part.type === "text")).toEqual([
        expect.objectContaining({ text: "Child B answer" }),
      ]);
      expect(bAssistant.info).toMatchObject({
        finish: "tool-calls",
        time: { completed: expect.any(Number) },
      });
      expect(root!.parts.filter((part) => part.type === "text")).toEqual([
        expect.objectContaining({ text: "Root answer" }),
      ]);
      for (const message of [root!, aAssistant, bAssistant]) {
        expect(message.info).toMatchObject({
          tokens: {
            input: 10,
            output: 5,
            reasoning: 2,
            cache: { read: 3, write: 2 },
          },
        });
        expect(
          message.parts.filter((part) => part.type === "step-finish"),
        ).toHaveLength(1);
      }
    }),
  );
});

test.each([
  [
    "unknown delegate",
    [{ type: "text-start", id: "x", providerMetadata: ownedBy("missing") }],
  ],
  [
    "child content before start-step",
    [
      ...proxy("a"),
      { type: "text-start", id: "x", providerMetadata: ownedBy("a") },
    ],
  ],
  [
    "proxy before child finish-step",
    [
      ...proxy("a"),
      { type: "start-step", providerMetadata: ownedBy("a") },
      result("a"),
    ],
  ],
  [
    "proxy in the child scope it closes",
    [
      ...proxy("a"),
      { type: "start-step", providerMetadata: ownedBy("a") },
      { ...finishStep(), providerMetadata: ownedBy("a") },
      result("a", "a"),
    ],
  ],
  [
    "child restart",
    [
      ...proxy("a"),
      { type: "start-step", providerMetadata: ownedBy("a") },
      { ...finishStep(), providerMetadata: ownedBy("a") },
      { type: "start-step", providerMetadata: ownedBy("a") },
    ],
  ],
] satisfies [string, LLM.SuccessStreamEvent[]][])(
  "rejects %s without retry",
  async (_name, events) => {
    await run((fixture) =>
      Effect.gen(function* () {
        fixture.source = () => streamOf({ type: "start-step" }, ...events);
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        const exit = yield* Effect.exit(processor.process(fixture.request));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(fixture.calls).toHaveLength(1);
      }),
    );
  },
);

test("transport failure closes open delegate text, tool proxy, and Assistant", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.source = () =>
        Stream.concat(
          streamOf(
            { type: "start-step" },
            ...proxy("a"),
            { type: "start-step", providerMetadata: ownedBy("a") },
            {
              type: "text-start",
              id: "partial",
              providerMetadata: ownedBy("a"),
            },
            {
              type: "text-delta",
              id: "partial",
              text: "Partial child",
              providerMetadata: ownedBy("a"),
            },
          ),
          Stream.fail(
            new RequestFailed({ cause: new Error("connection lost") }),
          ),
        );
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      expect(
        Exit.isFailure(yield* Effect.exit(processor.process(fixture.request))),
      ).toBe(true);
      const root = yield* fixture.session.getMessage({
        sessionID: fixture.assistant.sessionID,
        messageID: fixture.assistant.id,
      });
      const rootProxy = root!.parts.find(
        (part): part is ToolPart => part.type === "tool",
      )!;
      expect(rootProxy.state.status).toBe("error");
      const child = (yield* fixture.session.listMessages({
        sessionID: rootProxy.childSessionIds[0]!,
        limit: 10,
      })).items.find((message) => message.info.role === "assistant")!;
      expect(child.info).toMatchObject({
        time: { completed: expect.any(Number) },
        error: { name: "UnknownError" },
      });
      expect(child.parts.filter((part) => part.type === "text")).toEqual([
        expect.objectContaining({
          text: "Partial child",
          time: { start: expect.any(Number), end: expect.any(Number) },
        }),
      ]);
      expect(child.parts.some((part) => part.type === "step-finish")).toBe(
        false,
      );
    }),
  );
});

test("a failed proxy write still finalizes the already-created child Assistant", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      fixture.source = () => streamOf({ type: "start-step" }, ...proxy("a"));
      const failure = new Error("Proxy write failed");
      const checked: Session.Interface = {
        ...fixture.session,
        updatePart: (part) =>
          part.type === "tool" && part.childSessionIds.length > 0
            ? Effect.die(failure)
            : fixture.session.updatePart(part),
      };
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      }).pipe(Effect.provideService(Session.Service, checked));
      const exit = yield* Effect.exit(processor.process(fixture.request));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons
            .filter(Cause.isDieReason)
            .map((reason) => reason.defect),
        ).toContain(failure);
      }
      const sessions = yield* fixture.session.list({
        parentId: fixture.assistant.sessionID,
        limit: 10,
      });
      expect(sessions.items).toHaveLength(1);
      const child = (yield* fixture.session.listMessages({
        sessionID: sessions.items[0]!.id,
        limit: 10,
      })).items.find((message) => message.info.role === "assistant")!;
      expect(child.info).toMatchObject({
        time: { completed: expect.any(Number) },
        error: { name: "UnknownError" },
      });
    }),
  );
});

test.each(["local", "provider-mcp"])(
  "rejects delegate creation from %s tool execution",
  async (execution) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const events = proxy("a").map((event) =>
          event.type === "tool-call"
            ? {
                ...event,
                providerExecuted: execution === "provider-mcp",
                providerMetadata: {
                  ...event.providerMetadata,
                  openchart: {
                    ...event.providerMetadata?.openchart,
                    ...(execution === "provider-mcp"
                      ? { toolExecution: "provider-mcp" as const }
                      : {}),
                  },
                },
              }
            : event,
        );
        fixture.source = () => streamOf({ type: "start-step" }, ...events);
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        const exit = yield* Effect.exit(processor.process(fixture.request));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            "Only observed provider calls may open delegates",
          );
        expect(
          (yield* fixture.session.list({
            parentId: fixture.assistant.sessionID,
            limit: 10,
          })).items,
        ).toEqual([]);
      }),
    );
  },
);
