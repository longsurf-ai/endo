// Purpose: Decodes native Agent events and exposes existing commands over the shared app transport.

import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";
import { filter, from, map, Observable, share, takeUntil } from "rxjs";
import { z } from "zod";

import type {
  AgentInputs,
  AgentSessionState,
  AppTransport,
} from "@openchart/app/lib/transport/transport";

const Native = z
  .unknown()
  .transform((value): AGUIEvent => EventSchemas.parse(value));
const Live = z.object({ sessionID: z.string(), event: Native });
const SessionSnapshot = z.object({
  sessionID: z.string(),
  events: z.array(Native),
});
const SessionSummary = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const SessionPage = z.object({
  items: z.array(
    SessionSummary.extend({ isActive: z.boolean(), isUnread: z.boolean() }),
  ),
  nextCursor: z.string().nullable(),
});

/** Session metadata and derived activity; listing never opens its transcript. */
export type ListedSession = z.infer<typeof SessionPage>["items"][number];
/** Native Agent state owned by the backend and reduced by AG-UI. */
export type SessionState = AgentSessionState;
/** Existing provider/model choice accepted with a prompt. */
export type ModelSelection = AgentInputs["prompt"]["input"]["model"];
/** Existing creation contract; a selection remains local until the first send. */
export type DigInInput = AgentInputs["digInSession"];
/** Existing permission response accepted by the backend. */
export type QuestionReply = AgentInputs["replyQuestion"]["reply"];
export type QuestionRequest = SessionState["questions"][number];
export type PermissionReply = AgentInputs["replyPermission"]["reply"];

/**
 * Adapts the shared transport without owning a directory cache or execution.
 * @example const remote = createAgentClient(transport);
 */
export function createAgentClient(transport: AppTransport) {
  const client = transport.rpc;
  const agentEvents = transport.events.pipe(
    map((frame) => {
      if (frame.kind !== "event") return frame;
      if (frame.event.type === "agent.snapshot")
        return {
          kind: "snapshot" as const,
          data: SessionSnapshot.parse(frame.event.data),
        };
      if (frame.event.type === "agent.event")
        return { kind: "live" as const, data: Live.parse(frame.event.data) };
      return undefined;
    }),
    share(),
  );
  return {
    transport,
    events: transport.events,
    directoryChanges: agentEvents.pipe(
      filter((frame) => {
        if (
          frame?.kind !== "live" ||
          frame.data.event.type !== EventType.STATE_DELTA
        )
          return false;
        const change = frame.data.event.delta.find(
          (delta) => delta.op === "add" && delta.path === "/session",
        );
        if (change) {
          const session = SessionSummary.parse(change.value);
          if (session.id !== frame.data.sessionID)
            throw new Error(
              "Session metadata must match its event session ID.",
            );
        }
        return (
          change !== undefined ||
          frame.data.event.delta.some((delta) => delta.path === "/runs")
        );
      }),
      map(() => undefined),
    ),
    getOrCreateBoundSession: (input: AgentInputs["getOrCreateBoundSession"]) =>
      client.agent.getOrCreateBoundSession.mutate(input),
    createSession: (input: AgentInputs["createSession"]) =>
      client.agent.createSession.mutate(input),
    forkSession: (input: AgentInputs["forkSession"]) =>
      client.agent.forkSession.mutate(input),
    truncateSession: (input: AgentInputs["truncateSession"]) =>
      client.agent.truncateSession.mutate(input),
    digInSession: (input: DigInInput) =>
      client.agent.digInSession.mutate(input),
    renameSession: (input: AgentInputs["renameSession"]) =>
      client.agent.renameSession.mutate(input),
    archiveSession: (input: AgentInputs["archiveSession"]) =>
      client.agent.archiveSession.mutate(input),
    markSessionRead: (input: AgentInputs["markSessionRead"]) =>
      client.agent.markSessionRead.mutate(input),
    listSessions: async (
      input: AgentInputs["listSessions"] = {},
      request: { signal?: AbortSignal } = {},
    ) =>
      SessionPage.parse(await client.agent.listSessions.query(input, request)),
    readTranscriptPage: (
      input: AgentInputs["readTranscriptPage"],
      request: { signal?: AbortSignal } = {},
    ) => client.agent.readTranscriptPage.query(input, request),
    models: (request: { signal?: AbortSignal } = {}) =>
      client.models.list.query(undefined, request),
    commands: (request: { signal?: AbortSignal } = {}) =>
      client.agent.commands.query(undefined, request),
    buildCommand: (input: AgentInputs["buildCommand"]) =>
      client.agent.buildCommand.mutate(input),
    restoreCommand: (input: AgentInputs["restoreCommand"]) =>
      client.agent.restoreCommand.mutate(input),
    observe: (sessionID: string) =>
      new Observable<AGUIEvent>((subscriber) => {
        let initialized = false;
        let snapshotRequested = false;
        const requestSnapshot = () => {
          snapshotRequested = true;
          initialized = false;
          // A replacement snapshot, disconnect, or detach ends obsolete errors.
          subscriber.add(
            from(client.agent.requestSnapshot.mutate({ sessionID }))
              .pipe(
                takeUntil(
                  agentEvents.pipe(
                    filter(
                      (frame) =>
                        frame?.kind === "connecting" ||
                        (frame?.kind === "snapshot" &&
                          frame.data.sessionID === sessionID),
                    ),
                  ),
                ),
              )
              .subscribe({ error: (error) => subscriber.error(error) }),
          );
        };
        const subscription = agentEvents.subscribe({
          next: (frame) => {
            if (!frame) return;
            if (frame.kind === "connecting") {
              initialized = false;
              return;
            }
            if (frame.kind === "ready") return requestSnapshot();
            if (frame.data.sessionID !== sessionID) return;
            if (frame.kind === "snapshot") {
              if (initialized) return;
              for (const event of frame.data.events) subscriber.next(event);
              initialized = true;
              return;
            }
            if (initialized) subscriber.next(frame.data.event);
          },
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });
        // Another Agent observer may already own the shared decoded stream.
        if (transport.ready && !snapshotRequested) requestSnapshot();
        return () => subscription.unsubscribe();
      }),
    prompt: (input: AgentInputs["prompt"]) => client.agent.prompt.mutate(input),
    cancel: (sessionID: string) => client.agent.cancel.mutate({ sessionID }),
    replyQuestion: (requestID: string, reply: QuestionReply) =>
      client.agent.replyQuestion.mutate({ requestID, reply }),
    replyPermission: (requestID: string, reply: PermissionReply) =>
      client.agent.replyPermission.mutate({ requestID, reply }),
  };
}

/** Typed commands and observation consumed by the framework-independent session registry. */
export type AgentClient = ReturnType<typeof createAgentClient>;

/** A visible complete-turn page, using the same projection as the live snapshot. */
export type TranscriptPage = Awaited<
  ReturnType<AgentClient["readTranscriptPage"]>
>;
