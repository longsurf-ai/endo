// Purpose: Evaluates Agent permissions and owns pending approvals and their lifecycle.

export * as Permission from "./permission";

import { delegateObservers } from "@openchart/server/agent/session/delegate-observers";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import * as Identifier from "@openchart/identifier";
import { Context, Deferred, Effect, Layer, Semaphore } from "effect";

export * from "./types";
export { evaluate, merge } from "./rules";
import {
  ID,
  type Request,
  type AskInput,
  type ReplyInput,
  type Decision,
  type Ruleset,
  type Reply,
} from "./types";

import {
  BlockedError,
  CorrectedError,
  DeclinedError,
  NotFoundError,
} from "./errors";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { evaluate, match } from "./rules";
import * as Saved from "./saved";

/** Recoverable enforcement failures; unqualified rejection aborts as a defect. */
export type Error = BlockedError | CorrectedError;

/** Permission requests, replies, and pending-request listing capabilities. */
export interface Interface {
  /**
   * Requests permission and returns only after it is granted. When approval is
   * needed, delivers pending-state changes and waits for a reply. Configured denial
   * fails with BlockedError; interruption removes the waiting request.
   * Rejection with feedback fails with CorrectedError; rejection without
   * feedback aborts with a Permission.DeclinedError defect.
   * @throws StoreNotFound when the Session does not exist.
   * @example
   * yield* permission.ask({
   *   sessionID: 'session-1', action: 'read', resources: ['/notes'],
   * });
   */
  readonly ask: (input: AskInput) => Effect.Effect<void, Error | StoreNotFound>;

  /**
   * Settles a pending request. Always also remembers its save patterns;
   * reject also rejects other pending requests in the same Session.
   * @throws NotFoundError when the request is no longer pending.
   * @example
   * yield* permission.reply({requestID: request.id, reply: 'once'});
   */
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>;

  /**
   * Lists all pending requests, or those visible to a Session: its own requests
   * and those of its delegated descendants. Request ownership stays unchanged.
   * @example
   * const requests = yield* permission.list(sessionID);
   */
  readonly list: (sessionID?: string) => Effect.Effect<ReadonlyArray<Request>>;
}

/**
 * Agent permission capability supplied by layer. Each instance owns its
 * pending approvals; persisted allow patterns belong to its application DB.
 * @example
 * const permission = yield* Permission.Service;
 * const requests = yield* permission.list();
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Permission",
) {}

interface Pending {
  readonly request: Request;
  readonly agent?: string | null;
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>;
}

const missingAgentRules: Ruleset = [
  { action: "*", resource: "*", decision: "deny" },
];

/**
 * Provides the three Permission operations using Profiles, Database, and Events.
 * The owner must share this Layer across the requesting and replying callers.
 * Waiting never holds a database transaction or the service's mutation lock.
 * Scope disposal rejects every outstanding approval and clears pending state.
 * @example
 * const permissions = Permission.layer.pipe(
 *   Layer.provide(Layer.mergeAll(profileLayer, databaseLayer, Events.layer)),
 * );
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const profiles = yield* AgentProfile.Service;
    const database = yield* Database.Service;
    const { db } = database;
    const events = yield* Events.Service;
    const publisher = yield* Publisher.Service;
    const lock = yield* Semaphore.make(1);
    const pending = new Map<ID, Pending>();
    let closed = false;
    // Delegation makes approvals visible to ancestors without transferring
    // ownership or requiring a transcript/ToolPart link.
    const observers = (sessionID: string) =>
      delegateObservers(sessionID).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      );

    // Bootstrap holds the Events barrier, so reads must not acquire the
    // mutation lock (writers acquire the lock before that barrier).
    const list: Interface["list"] = Effect.fn("Permission.list")(
      function* (sessionID) {
        const requests = Array.from(pending.values(), (item) =>
          structuredClone(item.request),
        );
        if (sessionID === undefined) return requests;
        const visible: Request[] = [];
        for (const request of requests) {
          if ((yield* observers(request.sessionID)).has(sessionID))
            visible.push(request);
        }
        return visible;
      },
    );

    const publishPending = Effect.fn("Permission.publishPending")(function* (
      sessionID: string,
    ) {
      for (const observer of yield* observers(sessionID)) {
        yield* publisher.publish({
          type: "permissions.updated",
          sessionID: observer,
          permissions: yield* list(observer),
        });
      }
    });

    yield* Effect.addFinalizer(() =>
      lock.withPermit(
        Effect.gen(function* () {
          closed = true;
          for (const item of pending.values()) {
            yield* Deferred.fail(item.deferred, new DeclinedError({}));
          }
          pending.clear();
        }),
      ),
    );

    const configured = Effect.fn("Permission.configured")(function* (
      input: AskInput,
    ) {
      const session = yield* db
        .transaction((tx) => sessionStore.get(tx, input.sessionID))
        .pipe(Effect.orDie);
      if (!session) {
        return yield* new StoreNotFound({
          entity: "session",
          id: input.sessionID,
        });
      }
      // Native providers skip profile rules. Empty rules default to ask, so
      // execution still requires user approval unless a saved allow grant matches.
      if (input.agent === null) return [];

      const profile = yield* profiles.resolve(input.agent);
      return profile?.permission ?? missingAgentRules;
    });

    const denied = (input: AskInput, rules: Ruleset) =>
      input.resources.some(
        (resource) =>
          evaluate(input.action, resource, rules).decision === "deny",
      );

    const evaluateInput = Effect.fn("Permission.evaluate")(function* (
      input: AskInput,
    ) {
      if (closed) return yield* Effect.die("Permission service is closed");
      const rules = yield* configured(input);
      // Saved allow patterns never override the configured final deny decision.
      if (denied(input, rules)) return { decision: "deny" as const, rules };
      const all = [...rules, ...(yield* Saved.list(db))];
      const decisions = input.resources.map(
        (resource) => evaluate(input.action, resource, all).decision,
      );
      const decision: Decision = decisions.includes("ask") ? "ask" : "allow";
      return { decision, rules: all };
    });

    const create = Effect.fn("Permission.create")(function* (
      input: AskInput,
      id: ID,
    ) {
      if (pending.has(id)) {
        return yield* Effect.die(`Duplicate pending permission ID: ${id}`);
      }
      const deferred = yield* Deferred.make<
        void,
        DeclinedError | CorrectedError
      >();
      const request: Request = structuredClone({
        id,
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      });
      const item: Pending = { request, agent: input.agent, deferred };
      yield* events.withBarrier(
        Effect.gen(function* () {
          pending.set(id, item);
          yield* publishPending(request.sessionID).pipe(
            Effect.onError(() => Effect.sync(() => pending.delete(id))),
          );
        }),
      );
      return item;
    });

    const ask: Interface["ask"] = Effect.fn("Permission.ask")((input) =>
      // Registration and cleanup must finish; waiting restores caller interruption.
      Effect.acquireUseRelease(
        lock.withPermit(
          Effect.gen(function* () {
            const result = yield* evaluateInput(input);
            if (result.decision === "deny") {
              return yield* new BlockedError({
                rules: result.rules.filter((rule) =>
                  match(input.action, rule.action),
                ),
              });
            }
            if (result.decision === "allow") return;
            return yield* create(
              input,
              input.id ?? ID.make(`per_${Identifier.ascending()}`),
            );
          }),
        ),
        (item) =>
          item
            ? Deferred.await(item.deferred).pipe(
                Effect.catchTag("Permission.DeclinedError", Effect.die),
              )
            : Effect.void,
        (item) =>
          item
            ? lock.withPermit(
                events.withBarrier(
                  Effect.gen(function* () {
                    // A settled ID may already belong to a newer request by this time.
                    if (pending.get(item.request.id) === item) {
                      pending.delete(item.request.id);
                      yield* publishPending(item.request.sessionID);
                    }
                  }),
                ),
              )
            : Effect.void,
      ),
    );

    const settle = Effect.fn("Permission.settle")(function* (
      item: Pending,
      reply: Reply,
      message?: string,
    ) {
      yield* events.withBarrier(
        Effect.gen(function* () {
          pending.delete(item.request.id);
          yield* publishPending(item.request.sessionID);
        }),
      );
      if (reply === "reject") {
        yield* Deferred.fail(
          item.deferred,
          message
            ? new CorrectedError({ feedback: message })
            : new DeclinedError({}),
        );
        return;
      }
      yield* Deferred.succeed(item.deferred, undefined);
    });

    const reply: Interface["reply"] = Effect.fn("Permission.reply")(
      function* (input) {
        const item = pending.get(input.requestID);
        if (!item)
          return yield* new NotFoundError({ requestID: input.requestID });
        if (input.reply === "reject") {
          yield* settle(item, "reject", input.message);
          for (const other of pending.values()) {
            if (other.request.sessionID === item.request.sessionID)
              yield* settle(other, "reject");
          }
          return;
        }
        const save = input.reply === "always" && item.request.save?.length;
        // Commit before reporting approval or releasing any waiting tool.
        if (save) yield* Saved.add(db, item.request.action, item.request.save!);
        yield* settle(item, input.reply);
        if (!save) return;
        const remembered = yield* Saved.list(db);
        for (const other of pending.values()) {
          const request = { ...other.request, agent: other.agent };
          const rules = yield* configured(request).pipe(
            Effect.catchTag("AgentStore.NotFound", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!rules || denied(request, rules)) continue;
          if (
            request.resources.every(
              (resource) =>
                evaluate(request.action, resource, rules, remembered)
                  .decision === "allow",
            )
          )
            yield* settle(other, "always");
        }
      },
      lock.withPermit,
      Effect.uninterruptible,
    );

    return Service.of({
      ask,
      reply,
      list,
    });
  }),
);
