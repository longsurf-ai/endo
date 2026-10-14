// Purpose: Surfaces native async questions through the existing host callback for one live turn.
import {
  EmptyResponse,
  QuestionResponse,
  type AsyncQuestionRequest,
  type ServerRequest,
} from "./protocol";
import type { CodexRpc } from "./rpc";

type QuestionRequest = Extract<
  ServerRequest,
  { method: "item/tool/requestUserInput" }
>;

interface Options {
  rpc: CodexRpc;
  signal: AbortSignal;
  ask(request: QuestionRequest, signal: AbortSignal): Promise<unknown>;
  requested(request: QuestionRequest["params"]): void;
  answered(id: string, output: unknown, isError: boolean): void;
}

/** Request-local bridge; it never starts a turn or waits on the event reader. */
export interface AsyncQuestions {
  /**
   * Starts one host wait per native item; duplicate events are ignored.
   * @example questions.ask({threadId, turnId, itemId, questions: nativeQuestions});
   */
  ask(request: AsyncQuestionRequest): void;
  /**
   * Expires questions from this native thread before its turn/delegate closes.
   * @example questions.finishThread(threadId);
   */
  finishThread(threadId: string): void;
}

/**
 * Reuses the host question callback without blocking Codex. Answers are steered
 * once into the originating turn; skips, expiry, and delivery failures never
 * start another turn. Waits expire after 60 seconds or request/turn cancellation.
 * Completed entries stay request-local solely to deduplicate native items.
 * @example const questions = createAsyncQuestions({rpc, signal, ask, requested, answered});
 */
export function createAsyncQuestions(options: Options): AsyncQuestions {
  const requests = new Map<
    string,
    { threadId: string; controller: AbortController }
  >();
  return {
    ask({ threadId, turnId, itemId, questions }) {
      const id = `async-question:${threadId}:${itemId}`;
      if (options.signal.aborted || requests.has(id) || !questions.length)
        return;
      const controller = new AbortController();
      requests.set(id, { threadId, controller });
      const signal = AbortSignal.any([
        options.signal,
        controller.signal,
        AbortSignal.timeout(60_000),
      ]);
      const request: QuestionRequest = {
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: id,
          isBlocking: false,
          questions: questions.map((question, index) => ({
            id: String(index),
            header: question.title,
            question: question.title,
            isOther: true,
            isSecret: false,
            options: question.options?.map((label) => ({
              label,
              description: "",
            })),
          })),
        },
      };
      options.requested(request.params);
      const expired = () => options.answered(id, "Question expired", true);
      signal.addEventListener("abort", expired, { once: true });
      void (async () => {
        try {
          const reply = QuestionResponse.parse(
            await options.ask(request, signal),
          );
          if (signal.aborted) return;
          if (Object.keys(reply.answers).length) {
            await options.rpc.request(
              "turn/steer",
              {
                threadId,
                expectedTurnId: turnId,
                input: [
                  {
                    type: "text",
                    text: `The user answered your earlier questions:\n${JSON.stringify({ questions: request.params.questions, answers: reply.answers })}`,
                  },
                ],
              },
              EmptyResponse,
            );
          }
          if (!signal.aborted) options.answered(id, reply, false);
        } catch (error) {
          if (!signal.aborted)
            options.answered(
              id,
              error instanceof Error ? error.message : String(error),
              true,
            );
        } finally {
          signal.removeEventListener("abort", expired);
          controller.abort();
        }
      })();
    },
    finishThread(threadId) {
      for (const request of requests.values())
        if (request.threadId === threadId) request.controller.abort();
    },
  };
}
