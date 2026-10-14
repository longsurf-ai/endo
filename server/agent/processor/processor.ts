// Purpose: Projects one assistant model stream into committed transcript state using Effect.

export * as Processor from "./processor";

import { isDeepStrictEqual } from "node:util";
import type { Assistant } from "@openchart/server/agent/contracts/message";
import { SessionId } from "@openchart/server/agent/contracts/session";
import {
  ToolInput,
  ToolErrorInput,
  type ToolPart,
  type TextPart,
  type ReasoningPart,
} from "@openchart/server/agent/contracts/part";
import { ascending } from "@openchart/identifier";
import type { AvailableModel } from "@openchart/models/model-provider";
import { isObservedProviderTool } from "@openchart/models/provider-protocol";
import { nativeProvider } from "@openchart/models/providers";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { LLM } from "@openchart/server/agent/llm/llm";
import { Session } from "@openchart/server/agent/session/session";
import type { Tool } from "@openchart/server/agent/tool/tool";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Queue,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { createDelegates } from "./delegates";
import { isModelFailure, isRetryable, toMessageError } from "./errors";
import { getUsage } from "./usage";
import { toolResult, toolErrorMetadata, toolErrorMessage } from "./tool-result";
import { withIdleTimeout } from "./idle";
import {
  EVENT_START,
  EVENT_FINISH,
  EVENT_TEXT_START,
  EVENT_TEXT_DELTA,
  EVENT_TEXT_END,
  EVENT_REASONING_START,
  EVENT_REASONING_DELTA,
  EVENT_REASONING_END,
  EVENT_TOOL_INPUT_START,
  EVENT_TOOL_INPUT_DELTA,
  EVENT_TOOL_INPUT_END,
  EVENT_TOOL_CALL,
  EVENT_TOOL_RESULT,
  EVENT_TOOL_ERROR,
  EVENT_START_STEP,
  EVENT_FINISH_STEP,
} from "./processor-events";

/** Recorded model failures and unchanged Session operation failures. */
export type ProcessError =
  | NonNullable<Assistant["error"]>
  | Effect.Error<ReturnType<Session.Interface[keyof Session.Interface]>>;

/**
 * One root Assistant's stream processing, including its provider delegates.
 * Each instance owns its active Parts, tool waiters, and retries.
 * Method Effects preserve persistence, model, and callback requirements.
 *
 * ```
 * Prompt                           one Processor instance
 *   |                                      |
 *   | process(LLM.StreamInput) ----------->|
 *   |                                      |-- LLM.Service.stream(input)
 *   |                                      |       |
 *   |                                      |       v
 *   |                                      |   model events
 *   |                                      |       |
 *   |                                      |       v
 *   |                                      |-- Session.Service
 *   |                                      |   text/reasoning -> Parts
 *   |                                      |   tool events    -> ToolPart state
 *   |                                      |   finish-step    -> usage + marker
 *   |                                      |   deltas         -> committed snapshots
 *   |<-------- success: void --------------|
 *   |<-------- failure: ProcessError ------|
 *   |                                      |
 *   `-- read transcript, decide next       `-- processing finished
 * ```
 *
 * The root Assistant identity stays fixed. Provider delegates route to their
 * own Messages. The caller executes process once per instance; retries happen
 * inside it, only before projection or tool execution has begun.
 * The consuming Effect owns cancellation. Terminal cleanup closes active Parts
 * and releases tool waiters before processing exits. Mutable Assistant and
 * ToolPart state stays inside the instance; Prompt reads the committed transcript
 * to decide the next action and reports tool progress through methods.
 */
export type Interface = Readonly<Effect.Success<ReturnType<typeof create>>>;

/**
 * Creates processing state for one already-persisted, fresh Assistant.
 * Validates freshness once; Session supplies the canonical header. The caller
 * grants this instance exclusive access to the Assistant and owns the Prompt
 * loop. Cancellation follows process's fiber. The supplied model provides this
 * request's usage prices.
 *
 * @example
 * const processor = yield* Processor.create({assistantMessage, model});
 * yield* processor.process(input);
 */
export const create = Effect.fn("Processor.create")(function* (input: {
  assistantMessage: Assistant;
  model: AvailableModel;
}) {
  const session = yield* Session.Service;
  const stored = yield* session.getMessage({
    sessionID: input.assistantMessage.sessionID,
    messageID: input.assistantMessage.id,
  });
  assertExists(stored, "Processor requires a persisted Assistant");
  assertTrue(
    stored.info.role === "assistant",
    "Processor requires an Assistant",
  );
  assertTrue(
    stored.parts.length === 0 &&
      stored.info.time.completed === undefined &&
      stored.info.error === undefined,
    "Processor requires a fresh, unfinished Assistant",
  );
  assertTrue(
    stored.info.modelID === input.model.id &&
      stored.info.providerID === input.model.providerID,
    "Processor usage model must match the Assistant",
  );

  const transitionLock = yield* Semaphore.make(1);
  const callbackActivitySignals = yield* Queue.sliding<void>(1);
  const delegateRouter = createDelegates(structuredClone(stored.info), session);

  const toolPartsByCallID = new Map<string, ToolPart>();
  const toolPartWaitersByCallID = new Map<
    string,
    Deferred.Deferred<ToolPart>
  >();

  const activeTextStreams = new Map<string, TextPart | ReasoningPart>();
  // Cleanup closes the instance before storage writes, so late callbacks cannot
  // create new tool waiters or write progress even if cleanup fails.
  let closed = false;
  let retryBlocked = false;
  let activeCallbackCount = 0;

  const isWaitingForToolOrPermission = () =>
    // Permission waits need no ToolPart. Active callbacks suspend the timeout.
    activeCallbackCount > 0 ||
    // Provider-native tools and delegates run without local tool callbacks,
    // so their running Parts must also suspend the timeout.
    Array.from(toolPartsByCallID.values()).some(
      (part) => part.state.status === "running",
    );

  // One lock covers read -> commit -> replace, including progress callbacks.
  // A committed row and its in-memory owner must advance together.
  const withExclusiveTransition = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    transitionLock.withPermit(Effect.uninterruptible(effect));

  const saveTool = Effect.fn(function* (part: ToolPart) {
    const saved = yield* session.updatePart(part);
    toolPartsByCallID.set(part.callID, saved);
  });

  const mergeChildSessionIds = Effect.fn(function* (
    existing: readonly string[],
    incoming: readonly string[],
  ) {
    const childSessionIds = new Set(existing);
    for (const childSessionId of incoming) {
      if (childSessionIds.has(childSessionId)) continue;
      const child = yield* session.get(SessionId.make(childSessionId));
      assertTrue(
        child?.kind === "delegate" &&
          child.parentId === input.assistantMessage.sessionID,
        "A tool can only link its own Session's delegate",
      );
      childSessionIds.add(childSessionId);
    }
    return [...childSessionIds];
  });

  const isToolActive = (part: ToolPart) =>
    part.state.status === "pending" || part.state.status === "running";

  const errorInput = (value: unknown) =>
    Schema.is(ToolErrorInput)(value)
      ? value
      : {
          __openchart: {
            error: "non_json_tool_input",
            inputType: typeof value,
          },
        };

  const failTool = Effect.fn(function* (
    part: ToolPart,
    error: unknown,
    value: unknown = part.state.input,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* saveTool({
      ...part,
      state: {
        status: "error",
        input: errorInput(value),
        error: toolErrorMessage(error),
        metadata: { ...part.state.metadata, ...toolErrorMetadata(error) },
        time: {
          start: part.state.status === "pending" ? now : part.state.time.start,
          end: now,
        },
      },
    });
  });

  const finishTextEntry = Effect.fn(function* (key: string) {
    const part = activeTextStreams.get(key);
    assertExists(part, `No active text for ${key}`);
    const now = yield* Clock.currentTimeMillis;
    yield* session.updatePart({
      ...part,
      time: { start: part.time?.start ?? now, end: now },
    });
    activeTextStreams.delete(key);
  });

  const assertFinished = Effect.gen(function* () {
    for (const destination of delegateRouter.all()) {
      if (destination.step !== "finished") {
        yield* Effect.die(
          new Error("Model stream ended before every step finished"),
        );
      }
    }
  });

  const consume = Effect.fn(function* (event: LLM.SuccessStreamEvent) {
    const { delegateCallId, openDelegate } =
      event.providerMetadata?.openchart ?? {};
    assertTrue(
      openDelegate === undefined || event.type === EVENT_TOOL_CALL,
      "Delegate open belongs only on tool-call",
    );
    const destination = delegateRouter.route(delegateCallId);
    const message = destination.message;
    const now = yield* Clock.currentTimeMillis;
    if (
      event.type !== EVENT_START &&
      event.type !== EVENT_FINISH &&
      event.type !== EVENT_START_STEP
    ) {
      assertTrue(
        destination.step === "active",
        `${event.type} requires an active step`,
      );
    }

    // Same event sequence as V1: text, tools, then step accounting.
    switch (event.type) {
      case EVENT_START:
        break;
      case EVENT_TEXT_START:
      case EVENT_REASONING_START: {
        const type = event.type === EVENT_TEXT_START ? "text" : "reasoning";
        const key = `${type}:${event.id}`;
        assertTrue(!activeTextStreams.has(key), `Duplicate text start ${key}`);
        const part: TextPart | ReasoningPart = {
          id: `prt_${ascending()}`,
          messageID: message.id,
          type,
          text: "",
          time: { start: now },
          metadata: event.providerMetadata,
        };
        yield* session.createPart(part);
        activeTextStreams.set(key, part);
        break;
      }
      case EVENT_TEXT_DELTA:
      case EVENT_REASONING_DELTA:
      case EVENT_TEXT_END:
      case EVENT_REASONING_END: {
        const key = `${event.type.startsWith("text") ? "text" : "reasoning"}:${event.id}`;
        const part = activeTextStreams.get(key);
        assertExists(part, `No active text for ${key}`);
        assertTrue(
          part.messageID === message.id,
          `Text ${key} changed ownership`,
        );
        if (isUnchangedTextDelta(event, part)) break;
        if (event.providerMetadata) part.metadata = event.providerMetadata;

        if (
          event.type === EVENT_TEXT_END ||
          event.type === EVENT_REASONING_END
        ) {
          yield* finishTextEntry(key);
          break;
        }

        // Every published snapshot follows its committed Part update.
        part.text += event.text;
        yield* session.updatePart(part);
        break;
      }
      case EVENT_TOOL_INPUT_START: {
        assertTrue(
          !toolPartsByCallID.has(event.id),
          `Duplicate tool call ${event.id}`,
        );
        const part: ToolPart = {
          id: `prt_${ascending()}`,
          messageID: message.id,
          type: "tool",
          tool: event.toolName,
          callID: event.id,
          childSessionIds: [],
          state: { status: "pending", input: {} },
        };
        yield* session.createPart(part);
        toolPartsByCallID.set(event.id, part);
        break;
      }
      case EVENT_TOOL_INPUT_DELTA:
      case EVENT_TOOL_INPUT_END:
      case EVENT_TOOL_CALL:
      case EVENT_TOOL_RESULT:
      case EVENT_TOOL_ERROR: {
        const callID = "toolCallId" in event ? event.toolCallId : event.id;
        const part = toolPartsByCallID.get(callID);
        assertExists(
          part,
          `Tool ${callID} requires committed tool-input-start`,
        );
        assertTrue(
          part.messageID === message.id,
          `Tool ${callID} changed ownership`,
        );
        if (
          event.type === EVENT_TOOL_INPUT_DELTA ||
          event.type === EVENT_TOOL_INPUT_END
        ) {
          break; // Input deltas are not a second executable-input source.
        }
        if (event.type === EVENT_TOOL_CALL) {
          assertTrue(
            part.state.status === "pending",
            `Duplicate tool-call ${callID}`,
          );
          if (event.invalid || !Schema.is(ToolInput)(event.input)) {
            yield* failTool(
              {
                ...part,
                tool: event.toolName,
                providerMetadata: event.providerMetadata,
              },
              event.error ??
                (event.invalid
                  ? "Invalid tool call"
                  : "Tool input must be an object"),
              event.input,
            );
            break;
          }
          assertTrue(
            openDelegate === undefined || isObservedProviderTool(event),
            "Only observed provider calls may open delegates",
          );
          const childSessionId =
            openDelegate === undefined
              ? undefined
              : yield* delegateRouter.start(callID, destination, openDelegate);
          yield* saveTool({
            ...part,
            tool: event.toolName,
            childSessionIds:
              childSessionId === undefined ? [] : [childSessionId],
            providerMetadata: event.providerMetadata,
            state: {
              status: "running",
              input: event.input,
              time: { start: now },
            },
          });
          const waiter = toolPartWaitersByCallID.get(callID);
          if (waiter) {
            const running = toolPartsByCallID.get(callID);
            assertExists(running, "Tool callback requires its running Part");
            yield* Deferred.succeed(waiter, structuredClone(running));
            toolPartWaitersByCallID.delete(callID);
          }
          break;
        }
        delegateRouter.assertProxyFinished(callID);
        // Invalid SDK calls are followed by a paired tool-error.
        if (event.type === EVENT_TOOL_ERROR && part.state.status === "error")
          break;
        assertTrue(
          part.state.status === "running",
          `Terminal event for non-running tool ${callID}`,
        );
        if (event.type === EVENT_TOOL_ERROR) {
          yield* failTool(part, event.error, event.input ?? part.state.input);
          break;
        }
        yield* saveTool({
          ...part,
          providerMetadata: event.providerMetadata ?? part.providerMetadata,
          state: {
            status: "completed",
            input: part.state.input,
            ...toolResult(event, part),
            time: { start: part.state.time.start, end: now },
          },
        });
        break;
      }
      case EVENT_START_STEP: {
        assertTrue(
          destination.step !== "active" &&
            (destination === delegateRouter.root ||
              destination.step === "pending"),
          "A root step must finish before restarting; a delegate has exactly one step",
        );
        retryBlocked = true;
        yield* session.createPart({
          id: `prt_${ascending()}`,
          messageID: message.id,
          type: "step-start",
        });
        destination.step = "active";
        break;
      }
      case EVENT_FINISH_STEP: {
        assertTrue(
          !Array.from(activeTextStreams.values()).some(
            (part) => part.messageID === message.id,
          ),
          "Step finished with active text",
        );
        assertTrue(
          !Array.from(toolPartsByCallID.values()).some(
            (part) => part.messageID === message.id && isToolActive(part),
          ),
          "Step finished with active tools",
        );
        const usage = getUsage(input.model, event.usage);
        const tokens = message.tokens;
        const updated: Assistant = {
          ...message,
          finish: event.finishReason,
          cost: message.cost + usage.cost,
          tokens: {
            input: tokens.input + usage.tokens.input,
            output: tokens.output + usage.tokens.output,
            reasoning: tokens.reasoning + usage.tokens.reasoning,
            cache: {
              read: tokens.cache.read + usage.tokens.cache.read,
              write: tokens.cache.write + usage.tokens.cache.write,
            },
          },
          time: {
            ...message.time,
            ...(destination !== delegateRouter.root ||
            event.finishReason !== "tool-calls"
              ? { completed: now }
              : {}),
          },
        };
        yield* session.finishStep({
          message: updated,
          part: {
            id: `prt_${ascending()}`,
            messageID: message.id,
            type: "step-finish",
            reason: event.finishReason,
            ...usage,
          },
        });
        destination.message = updated;
        destination.step = "finished";
        break;
      }
      default:
        break; // Transport diagnostics and sources are not transcript Parts.
    }
  });

  // Every finalization write is attempted. Effect combines its failures with the
  // original failure/defect/interruption; waiter release cannot be skipped.
  const finalizeTranscript = (exit: Exit.Exit<void, unknown>) =>
    Effect.gen(function* () {
      closed = true;
      for (const waiter of toolPartWaitersByCallID.values())
        yield* Deferred.interrupt(waiter);
      toolPartWaitersByCallID.clear();
      const now = yield* Clock.currentTimeMillis;
      const error: Assistant["error"] =
        delegateRouter.root.message.error ??
        (Exit.isFailure(exit)
          ? Cause.hasInterrupts(exit.cause)
            ? {
                name: "MessageAbortedError",
                data: { message: "Model processing interrupted" },
              }
            : {
                name: "UnknownError",
                data: { message: Cause.pretty(exit.cause) },
              }
          : undefined);
      const writes = [];
      for (const key of activeTextStreams.keys())
        writes.push(finishTextEntry(key));
      // Nested provider proxies are created after their parents; close them
      // first so subagent completion preserves the same nesting on failure.
      for (const part of Array.from(toolPartsByCallID.values()).reverse())
        if (isToolActive(part))
          writes.push(
            failTool(
              part,
              error && "message" in error.data
                ? error.data.message
                : "Tool execution interrupted",
            ),
          );
      // Children are created after their parents. Seal them first so a root
      // completion event never precedes an unfinished child's terminal header.
      for (const destination of Array.from(delegateRouter.all()).reverse()) {
        if (
          destination !== delegateRouter.root &&
          destination.step === "finished"
        )
          continue;
        const message = destination.message;
        // Successful finish-step already committed the root's terminal header.
        if (Exit.isSuccess(exit) && message.time.completed !== undefined)
          continue;
        writes.push(
          session.updateMessage({
            ...message,
            ...(error ? { error } : {}),
            ...(destination !== delegateRouter.root ? { finish: "error" } : {}),
            time: { ...message.time, completed: now },
          }),
        );
      }
      const exits = yield* Effect.forEach(writes, Effect.exit);
      yield* Exit.asVoidAll(exits);
    });

  // Only actual tool/permission work is busy. Waiting for a missing tool event
  // stays outside this region, so a broken provider still reaches its deadline.
  const duringCallback = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        retryBlocked = true;
        activeCallbackCount++;
      }).pipe(Effect.andThen(Queue.offer(callbackActivitySignals, undefined))),
      () => effect,
      () =>
        Effect.sync(() => {
          activeCallbackCount--;
        }).pipe(
          Effect.andThen(Queue.offer(callbackActivitySignals, undefined)),
        ),
    );

  // Running commit precedes callback entry, so immediate progress cannot be lost.
  const waitForToolPart = (
    callID: ToolPart["callID"],
  ): Effect.Effect<ToolPart> =>
    Effect.suspend(() => {
      const part = toolPartsByCallID.get(callID);
      if (part?.state.status === "running")
        return Effect.succeed(structuredClone(part));
      if (closed) return Effect.interrupt;
      let waiter = toolPartWaitersByCallID.get(callID);
      if (!waiter) {
        waiter = Deferred.makeUnsafe<ToolPart>();
        toolPartWaitersByCallID.set(callID, waiter);
      }
      return Deferred.await(waiter).pipe(
        Effect.map((part) => structuredClone(part)),
      );
    });

  const createModelStream = <E, R>(
    llm: LLM.Interface,
    request: LLM.StreamInput<E, R>,
  ) =>
    llm.stream({
      ...request,
      retries: 0,
      tools: Object.fromEntries(
        Object.entries(request.tools).map(([name, tool]) => [
          name,
          {
            ...tool,
            execute: (args: unknown, options: LLM.ToolExecutionOptions) =>
              waitForToolPart(options.toolCallId).pipe(
                Effect.andThen(
                  duringCallback(
                    Effect.suspend(() => tool.execute(args, options)),
                  ),
                ),
              ),
          },
        ]),
      ),
      askQuestion: request.askQuestion
        ? (ask) =>
            duringCallback(Effect.suspend(() => request.askQuestion!(ask)))
        : undefined,
      askPermission: request.askPermission
        ? (ask) =>
            duringCallback(Effect.suspend(() => request.askPermission!(ask)))
        : undefined,
      recordRequestSnapshot: (snapshot) =>
        withExclusiveTransition(
          Effect.gen(function* () {
            const message = {
              ...delegateRouter.root.message,
              request: structuredClone(snapshot),
            };
            yield* session.updateMessage(message);
            delegateRouter.root.message = message;
          }),
        ).pipe(
          Effect.andThen(
            Effect.suspend(
              () => request.recordRequestSnapshot?.(snapshot) ?? Effect.void,
            ),
          ),
        ),
    });

  return {
    /**
     * Consumes a model stream and persists its transcript through terminal cleanup.
     * Prompt supplies history, bound tools, and permission callbacks. The SDK/MCP
     * bridge invokes those tools; the processor observes and records their events.
     * Each supplied tool callback starts only after its running ToolPart commits.
     * Processor owns that wait internally; callers need no separate barrier.
     *
     * An unrecoverable model failure is recorded in the transcript, then fails the
     * Effect with a detached error value after cleanup. Prompt carries that failure
     * to its run outcome without inspecting the internal Assistant. Persistence
     * failures retain their original types; defects and interruption retain their
     * causes. After success, Prompt reads the committed transcript and applies its
     * completion and next-action policy before starting another request.
     * Native agents own turn termination; output silence does not cancel them.
     * Ordinary model requests retain the idle deadline while not executing tools.
     *
     * @returns Completes with no value after transcript writes and cleanup finish.
     * @example
     * yield* processor.process(streamInput);
     * // Prompt now reads the transcript to decide whether more work is needed.
     */
    process: <E = never, R = never>(request: LLM.StreamInput<E, R>) =>
      Effect.gen(function* () {
        assertTrue(
          request.sessionID === delegateRouter.root.message.sessionID,
          "Processor Session differs from request",
        );
        const llm = yield* LLM.Service;
        const source = createModelStream(llm, request);
        yield* (
          nativeProvider(input.model.providerID)
            ? source
            : source.pipe(
                withIdleTimeout(
                  isWaitingForToolOrPermission,
                  120_000,
                  Queue.take(callbackActivitySignals),
                ),
              )
        ).pipe(
          Stream.runForEach((event) => withExclusiveTransition(consume(event))),
        );
      }).pipe(
        Effect.andThen(assertFinished),
        Effect.retry({
          times: 3,
          schedule: Schedule.exponential("2 seconds"),
          while: (error) =>
            !retryBlocked && isModelFailure(error) && isRetryable(error),
        }),
        Effect.catchIf(isModelFailure, (error) => {
          const recorded = toMessageError(error, input.model.providerID);
          delegateRouter.root.message.error = recorded;
          return Effect.fail(structuredClone(recorded));
        }),
        Effect.onExit((exit) =>
          withExclusiveTransition(finalizeTranscript(exit)),
        ),
      ),

    /**
     * Reports tool progress through the existing Tool.Context metadata contract.
     * The processor owns lookup, the running-state guard, persistence, and updating
     * its tracked Part. Progress never reopens a terminal Part; persistence failures
     * propagate unchanged to the executing tool callback.
     *
     * ```
     * Tool.execute
     *   -> ctx.metadata(progress)                 Prompt binds this callback
     *   -> processor.updateToolProgress(callID, progress)
     *        -> find running Part
     *        -> Session.updatePart
     *        -> update tracked Part
     * ```
     *
     * @example
     * // Bind this callback when Prompt constructs Tool.Context:
     * metadata: progress => processor.updateToolProgress(callID, progress)
     */
    updateToolProgress: (
      callID: ToolPart["callID"],
      progress: Parameters<Tool.Context["metadata"]>[0],
    ) =>
      withExclusiveTransition(
        Effect.gen(function* () {
          const part = toolPartsByCallID.get(callID);
          if (closed || part?.state.status !== "running") {
            // A delegate must not start if its parent can no longer record it.
            if (progress.childSessionIds?.length) yield* Effect.interrupt;
            return;
          }
          const childSessionIds = yield* mergeChildSessionIds(
            part.childSessionIds,
            progress.childSessionIds ?? [],
          );
          yield* saveTool({
            ...part,
            childSessionIds,
            state: {
              ...part.state,
              ...(progress.title !== undefined
                ? { title: progress.title }
                : {}),
              metadata: { ...part.state.metadata, ...progress.metadata },
            },
          });
        }),
      ),
  };
});

function isUnchangedTextDelta(
  event: LLM.SuccessStreamEvent,
  part: TextPart | ReasoningPart,
) {
  // The idle watchdog has already observed this event; unchanged progress
  // does not need another committed snapshot.
  return (
    (event.type === EVENT_TEXT_DELTA || event.type === EVENT_REASONING_DELTA) &&
    event.text === "" &&
    (event.providerMetadata === undefined ||
      isDeepStrictEqual(part.metadata, event.providerMetadata))
  );
}
