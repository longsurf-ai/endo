// Purpose: Produces ordinary stream events for one accepted deterministic tool call.

import { assertExists } from "@openchart/utils/assert";
import { Effect, Stream, type Schema } from "effect";
import type { LLM } from "./llm";

/** An accepted intent authorizes this exact tool call. */
export interface AcceptedToolCall {
  readonly toolName: string;
  readonly callID: string;
  readonly args: Schema.JsonObject;
}

/**
 * Supplies one local step through the normal Processor stream contract. Processor
 * wraps the supplied callback and owns all commits, timeouts, and terminal cleanup.
 * Expected tool failures become events; defects and interruption fail the stream.
 * @example
 * yield* processor.process(request).pipe(
 *   Effect.provideService(LLM.Service, toolCallStream(call)),
 * );
 */
export function toolCallStream(call: AcceptedToolCall): LLM.Interface {
  return {
    stream: (request) =>
      Stream.suspend(() => {
        const tool = request.tools[call.toolName];
        assertExists(tool, "Accepted intent requires its bound tool");
        const invocation = {
          toolCallId: call.callID,
          toolName: call.toolName,
          input: call.args,
        };
        const usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: {
            noCacheTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        };
        // Pull the callback only after emitting its call. The Processor's existing
        // barrier waits for the running commit before entering tool code.
        return Stream.fromIterable<LLM.SuccessStreamEvent>([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-start",
            id: call.callID,
            toolName: call.toolName,
          },
          { type: "tool-input-end", id: call.callID },
          { type: "tool-call", ...invocation },
        ]).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.suspend(() => tool.execute(call.args, invocation)).pipe(
                Effect.match({
                  onSuccess: (output): LLM.SuccessStreamEvent => ({
                    type: "tool-result",
                    ...invocation,
                    output,
                  }),
                  onFailure: (error): LLM.SuccessStreamEvent => ({
                    type: "tool-error",
                    ...invocation,
                    error,
                  }),
                }),
              ),
            ),
          ),
          Stream.concat(
            Stream.fromIterable<LLM.SuccessStreamEvent>([
              { type: "finish-step", finishReason: "tool-calls", usage },
              {
                type: "finish",
                finishReason: "tool-calls",
                rawFinishReason: undefined,
                totalUsage: usage,
              },
            ]),
          ),
        );
      }).pipe(Stream.scoped),
  };
}
