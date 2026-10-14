// Purpose: Owns workflow child Sessions and binds their serialized Effect execution.

import type { Invocation } from "@openchart/server/agent/prompt/execute";
import { Session } from "@openchart/server/agent/session";
import { Database } from "@openchart/server/db";
import {
  Transactor,
  type ResourceDefinition,
} from "@openchart/server/lib/resource";
import { ResourceName, resources } from "@openchart/server/resources/catalog";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Cause, Effect, Schema, Semaphore } from "effect";
import { Workflow } from "./workflow";
import { ChildFailed, SessionNotOwned } from "./errors";
import { immutable } from "./authoring/shared/immutable";

type SessionServices = Effect.Services<
  | ReturnType<Session.Interface["create"]>
  | ReturnType<Session.Interface["readTranscriptPage"]>
>;

/**
 * Binds one invocation's children to the existing prompt engine. Dependencies are
 * captured once at this host boundary, with no runtime, Promise, or detached fiber.
 * Every returned child Effect inherits the calling fiber's interruption and must
 * finish its transcript cleanup before it settles. Parent history is never copied.
 * Only this host's children may be continued; their turns and answer reads serialize.
 * @example
 * const host = yield* makeWorkflowHost(invocationContext, executeInvocation, {concurrency: 5});
 */
export const makeWorkflowHost = <E, R>(
  invocationContext: Invocation,
  execute: (invocationContext: Invocation) => Effect.Effect<void, E, R>,
  settings: Workflow.Settings,
) =>
  Effect.gen(function* () {
    const session = yield* Session.Service;
    const database = yield* Database.Service;
    const services = yield* Effect.context<R | SessionServices>();
    const children = new Map<string, Semaphore.Semaphore>();
    return Workflow.Service.of({
      parentPrompt: invocationContext.input,
      settings: immutable(settings),
      getResource: Effect.fnUntraced(
        function* (name: string, id: string) {
          const resourceName =
            yield* Schema.decodeUnknownEffect(ResourceName)(name);
          const definition: ResourceDefinition | undefined = resources.find(
            (resource) => resource.name === resourceName,
          );
          assertExists(
            definition,
            "A validated Resource must exist in the catalog",
          );
          const resourceId = yield* Schema.decodeUnknownEffect(definition.id)(
            id,
          );
          return yield* Transactor.run(definition.transitions.get(resourceId));
        },
        Effect.provideService(Database.Service, database),
      ),
      agent: (input, onSession, options) =>
        Effect.gen(function* () {
          let childId = options?.sessionId;
          if (childId === undefined) {
            const child = yield* session.create({
              parentId: invocationContext.sessionID,
              kind: "delegate",
              title: options?.title ?? `Workflow child · ${input.agent}`,
            });
            childId = child.id;
            children.set(childId, yield* Semaphore.make(1));
          }
          const lock = children.get(childId);
          if (!lock)
            return yield* Effect.fail(
              new SessionNotOwned({ sessionId: childId }),
            );
          const id = childId;
          yield* onSession(id);
          return yield* lock.withPermit(
            Effect.gen(function* () {
              yield* execute({
                rootRunID: invocationContext.rootRunID,
                sessionID: id,
                outputSchema: options?.outputSchema,
                input: {
                  ...input,
                  workspaceId:
                    input.workspaceId ?? invocationContext.input.workspaceId,
                },
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ChildFailed({
                      sessionId: id,
                      message: `Child ${id} failed: ${Cause.pretty(Cause.fail(cause))}`,
                      cause,
                    }),
                ),
              );
              const { history } = yield* session.readTranscriptPage({
                sessionID: id,
                turnLimit: 1,
              });
              const response = history.at(-1);
              assertExists(
                response,
                "A completed child requires a committed response",
              );
              assertTrue(
                response.info.role === "assistant",
                "A completed child response must be an Assistant",
              );
              return {
                sessionId: id,
                output: response.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              };
            }),
          );
        }).pipe(Effect.provideContext(services)),
    });
  });
