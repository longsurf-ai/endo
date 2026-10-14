// Purpose: Owns request-scoped clarification waits and their observable pending view.
export * as Question from "./question";
export * from "./types";

import { Context, Deferred, Effect, Layer, Semaphore } from "effect";
import * as Identifier from "@openchart/identifier";
import type { ProviderQuestionRequest } from "@openchart/models/provider-question";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { delegateObservers } from "@openchart/server/agent/session/delegate-observers";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { ID, type Request, type Reply, type ReplyInput } from "./types";
import { InvalidReply, NotFoundError } from "./errors";

/** One shared owner serves asks, replies, and reconnect snapshots. */
export interface Interface {
  /**
   * Publishes a question and waits without holding locks. Interruption removes it.
   * @example const answer = yield* question.ask({sessionID, questions});
   */
  readonly ask: (
    input: ProviderQuestionRequest & { readonly sessionID: string },
  ) => Effect.Effect<Reply, StoreNotFound>;
  /**
   * Validates and settles exactly one request; stale replies fail with NotFoundError.
   * @example yield* question.reply({requestID, reply: {type: 'skipped'}});
   */
  readonly reply: (
    input: ReplyInput,
  ) => Effect.Effect<void, NotFoundError | InvalidReply>;
  /**
   * Returns detached pending data for the owner and its delegated descendants.
   * @example const pending = yield* question.list(sessionID);
   */
  readonly list: (sessionID: string) => Effect.Effect<readonly Request[]>;
}

/** Process-local clarification capability; no pending state survives runtime disposal. */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Question",
) {}

interface Pending {
  readonly request: Request;
  readonly deferred: Deferred.Deferred<Reply>;
}

/**
 * Shares pending requests across provider callbacks and HTTP replies. Disposal
 * interrupts remaining waits; only explicit replies ever supply answers.
 * @example const questions = Question.layer.pipe(Layer.provide(dependencies));
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service;
    const events = yield* Events.Service;
    const publisher = yield* Publisher.Service;
    const lock = yield* Semaphore.make(1);
    const pending = new Map<ID, Pending>();
    let closed = false;
    const observers = (id: string) =>
      delegateObservers(id).pipe(
        Effect.provideService(Database.Service, database),
      );
    const list: Interface["list"] = Effect.fn("Question.list")(
      function* (sessionID) {
        const visible: Request[] = [];
        for (const { request } of Array.from(pending.values())) {
          if (
            (yield* observers(request.sessionID).pipe(Effect.orDie)).has(
              sessionID,
            )
          )
            visible.push(structuredClone(request));
        }
        return visible;
      },
    );
    const publish = Effect.fn("Question.publish")(function* (
      sessionID: string,
    ) {
      for (const observer of yield* observers(sessionID).pipe(Effect.orDie)) {
        yield* publisher.publish({
          type: "questions.updated",
          sessionID: observer,
          questions: yield* list(observer),
        });
      }
    });
    yield* Effect.addFinalizer(() =>
      lock.withPermit(
        Effect.gen(function* () {
          closed = true;
          for (const item of pending.values())
            yield* Deferred.interrupt(item.deferred);
          pending.clear();
        }),
      ),
    );

    const ask: Interface["ask"] = Effect.fn("Question.ask")((input) =>
      Effect.acquireUseRelease(
        lock.withPermit(
          Effect.gen(function* () {
            if (closed) return yield* Effect.interrupt;
            yield* observers(input.sessionID);
            const item: Pending = {
              request: structuredClone({
                ...input,
                id: ID.make(`que_${Identifier.ascending()}`),
              }),
              deferred: yield* Deferred.make<Reply>(),
            };
            yield* events.withBarrier(
              Effect.gen(function* () {
                pending.set(item.request.id, item);
                yield* publish(input.sessionID).pipe(
                  Effect.onError(() =>
                    Effect.sync(() => pending.delete(item.request.id)),
                  ),
                );
              }),
            );
            return item;
          }),
        ),
        (item) => Deferred.await(item.deferred),
        (item) =>
          lock.withPermit(
            events.withBarrier(
              Effect.gen(function* () {
                if (pending.get(item.request.id) !== item) return;
                pending.delete(item.request.id);
                yield* publish(item.request.sessionID);
              }),
            ),
          ),
      ),
    );

    const reply: Interface["reply"] = Effect.fn("Question.reply")(
      function* (input) {
        const item = pending.get(input.requestID);
        if (!item)
          return yield* new NotFoundError({ requestID: input.requestID });
        if (input.reply.type === "answered") {
          const answers = input.reply.answers;
          const questions = item.request.questions;
          if (
            Object.keys(answers).length !== questions.length ||
            questions.some((question) => {
              const values = Object.hasOwn(answers, question.id)
                ? answers[question.id]
                : undefined;
              return (
                !values?.length ||
                (!question.multiple && values.length !== 1) ||
                new Set(values).size !== values.length ||
                values.some(
                  (value) =>
                    !value.trim() ||
                    (!question.allowFreeform &&
                      !question.options.some(
                        (option) => option.label === value,
                      )),
                )
              );
            })
          )
            return yield* new InvalidReply({
              message:
                "Answer every question using its available choices or text input.",
            });
        }
        yield* events.withBarrier(
          Effect.gen(function* () {
            pending.delete(item.request.id);
            yield* publish(item.request.sessionID).pipe(
              Effect.onError(() =>
                Effect.sync(() => pending.set(item.request.id, item)),
              ),
            );
            yield* Deferred.succeed(
              item.deferred,
              structuredClone(input.reply),
            );
          }),
        );
      },
      lock.withPermit,
      Effect.uninterruptible,
    );
    return Service.of({ ask, reply, list });
  }),
);
