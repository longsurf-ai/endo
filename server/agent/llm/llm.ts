// Purpose: Prepares one model request and exposes its unchanged events through a scoped Effect stream.

export * as LLM from "./llm";

import type { JSONSchema7 } from "@ai-sdk/provider";
import type {
  LlmRequest,
  LlmToolDefinition,
  User,
} from "@openchart/server/agent/contracts/message";
import { ToolInput } from "@openchart/server/agent/contracts/part";
import { nativeProvider } from "@openchart/models/providers";
import type { AvailableModel } from "@openchart/models/model-provider";
import { conformProviderStream } from "@openchart/models/stream";
import {
  providerToolInputSchema,
  type ProviderTools,
  type ProviderToolExecutionOptions,
} from "@openchart/models/provider-tools";
import type { ProviderPermissionAsk } from "@openchart/models/provider-permission";
import type {
  ProviderQuestionAsk,
  ProviderQuestionReply,
} from "@openchart/models/provider-question";
import type { ModelStreamEvent } from "@openchart/models/stream";
import { ProviderTransform } from "@openchart/models/transform";
import type { RequestAgent } from "@openchart/server/agent/profiles/profile";
import type { Tool } from "@openchart/server/agent/tool/tool";
import { Models } from "@openchart/server/models";
import { config as modelConfig } from "@openchart/server/models/config";
import {
  ConfigurationUnavailable,
  type ModelError,
} from "@openchart/server/models/errors";
import {
  isStepCount,
  jsonSchema,
  Output,
  streamText,
  tool,
  type ModelMessage,
} from "ai";
import {
  Context,
  Effect,
  JsonSchema,
  Layer,
  Schema,
  Stream,
  identity,
} from "effect";
import {
  InvalidToolArguments,
  PermissionUnavailable,
  RequestFailed,
  VariantNotFound,
} from "./errors";
import { repairToolCall } from "./tool-call-repair";
import {
  createCallbackRuntime,
  type CallbackRuntime,
} from "./callback-runtime";

const MAX_OUTPUT_TOKENS = 32_000;

/** Invocation identity supplied by LLM; cancellation follows the executing fiber. */
export interface ToolExecutionOptions {
  readonly toolCallId: string;
}

/** Caller-bound executable tool; LLM inspects only its schema's encoded side. */
export interface StreamTool<R = never> {
  readonly description: string;

  readonly parameters: Schema.Decoder<unknown>;

  readonly formatValidationError?: (error: Schema.SchemaError) => string;

  /**
   * Executes original input after encoded-side validation. The caller owns full
   * decoding, persistence, and permission checks. Results use Tool.ExecuteResult.
   * Cancellation follows the executing fiber. The SDK handles expected failures
   * and cancellation rejections; defects terminate the request.
   * @example
   * const result = yield* definition.execute({query: 'AAPL'}, {toolCallId});
   */
  readonly execute: (
    input: unknown,
    options: ToolExecutionOptions,
  ) => Effect.Effect<Tool.ExecuteResult, unknown, R>;
}

/** Complete input for one consumption; cancellation belongs to the stream Scope. */
export interface StreamInput<E = never, R = never> {
  /** Host-resolved absolute workspace root, shared by every attempt of this request. */
  readonly cwd: string;
  /** Caller-resolved model; request preparation never selects another model. */
  readonly model: AvailableModel;
  readonly user: Pick<User, "id" | "model">;
  readonly sessionID: string;
  readonly agent: RequestAgent;
  readonly system: string[];
  readonly messages: ModelMessage[];
  readonly tools: Record<string, StreamTool<R>>;
  /** Serializable final-answer schema; the caller owns decoding the result. */
  readonly outputSchema?: LlmRequest["outputSchema"];

  readonly retries?: number;

  /**
   * Supplies application permission policy as an Effect, scoped to this request.
   * @example
   * askPermission: request => permissions.ask(request)
   */
  readonly askPermission?: (
    request: Parameters<ProviderPermissionAsk>[0],
  ) => Effect.Effect<void, unknown, R>;
  /** Waits for user input inside this request scope. */
  readonly askQuestion?: (
    request: Parameters<ProviderQuestionAsk>[0],
  ) => Effect.Effect<ProviderQuestionReply, unknown, R>;
  readonly headers?: Record<string, string>;

  /**
   * Records the prepared snapshot before model I/O; failure prevents the request
   * and propagates unchanged through the stream's typed error channel.
   * @example
   * recordRequestSnapshot: request => Effect.sync(() => snapshots.push(request))
   */
  readonly recordRequestSnapshot?: (
    request: LlmRequest,
  ) => Effect.Effect<void, E, R>;
}

/** SDK `error` events fail the stream with {@link RequestFailed}. */
export type SuccessStreamEvent = Exclude<
  ModelStreamEvent<Tool.ExecuteResult>,
  { type: "error" }
>;

/** Expected model lookup or request failures. */
export type LlmError = ModelError | RequestFailed | VariantNotFound;

/** Replaceable single-request model execution boundary. */
export interface Interface {
  /**
   * Starts a fresh request when consumed and aborts it when consumption ends.
   * Each consumption owns its request Scope. Local tools stop after one SDK step;
   * callers decide whether to continue. Snapshot persistence failures retain
   * their original type and value instead of becoming provider failures.
   * @example
   * const events = yield* Stream.runCollect(llm.stream(input));
   */
  readonly stream: typeof stream;
}

/**
 * Injectable model-request execution; callers may provide another implementation.
 * @example
 * const llm = yield* LLM.Service;
 * const events = yield* Stream.runCollect(llm.stream(input));
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/LLM",
) {}

/**
 * Provides lazy model execution; Models and callback requirements surface on consumption.
 * The supplied Models scope must outlive all requests using this service.
 * @example
 * const llmLayer = LLM.layer.pipe(Layer.provideMerge(modelsLayer));
 */
export const layer = Layer.succeed(Service, { stream });

function stream<E = never, R = never>(input: StreamInput<E, R>) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const callbackRuntime = yield* createCallbackRuntime<R>();

      // Covers a request that streamText already started when the Scope
      // closes before the source stream below has begun pulling.
      // Stream.runCollect will provide the scope needed when running
      // this stream.
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

      const events: AsyncIterable<ModelStreamEvent<Tool.ExecuteResult>> =
        yield* run(input, controller.signal, callbackRuntime);
      return Stream.fromAsyncIterable(events, identity).pipe(
        // On interruption, Scope cleanup reaches return() before abort:
        //   Without ensuring: return() waits for read -> waits for abort -> stuck
        //   With ensuring:    abort -> read settles -> return() completes
        //
        // Keep the earlier finalizer for requests started before pulling.
        Stream.ensuring(Effect.sync(() => controller.abort())),
        Stream.orDie,
        Stream.mapEffect((event) =>
          event.type === "error"
            ? Effect.fail(new RequestFailed({ cause: event.error }))
            : Effect.succeed(event),
        ),
        Stream.interruptWhen(callbackRuntime.defect),
      );
    }),
  );
}

const run = Effect.fn("LLM.prepare")(function* <E, R>(
  input: StreamInput<E, R>,
  abort: AbortSignal,
  callbackRuntime: CallbackRuntime<R>,
) {
  if (!input.agent.prompt.trim()) {
    return yield* Effect.die(
      "An agent request requires a nonblank profile prompt",
    );
  }

  const models = yield* Models.Service;

  const selectedModel = yield* validateSelection(input);

  yield* Effect.logDebug("Preparing model request", {
    providerID: selectedModel.model.providerID,
    modelID: selectedModel.model.id,
    sessionID: input.sessionID,
    agent: input.agent.name,
  });

  const runToolCallback = (
    definition: StreamTool<R>,
    args: Effect.Effect<ToolInput, InvalidToolArguments>,
    options: ProviderToolExecutionOptions,
  ): Promise<Tool.ExecuteResult> => {
    const signal = options.abortSignal
      ? AbortSignal.any([abort, options.abortSignal])
      : abort;
    // SDK signals interrupt the callback fiber; Effect tool contracts do
    // not carry a second cancellation channel.
    return callbackRuntime.runPromise(
      args.pipe(
        Effect.flatMap((value) =>
          definition.execute(value, { toolCallId: options.toolCallId }),
        ),
      ),
      signal,
    );
  };

  const provider = nativeProvider(selectedModel.model.providerID);

  const system = buildSystemPrompt(input);

  const agentOptions = { ...input.agent.options };
  delete agentOptions["doNotSpillLongToolOutputToSandbox"];
  const options = ProviderTransform.options(
    selectedModel,
    provider,
    agentOptions,
  );
  const languageModel = yield* models.getLanguage(selectedModel.model);

  const definitions = Object.entries(input.tools).map(([id, definition]) => ({
    id,
    definition,
    schema: modelInputSchema(Schema.toEncoded(definition.parameters)),
    validate: toolInputValidator(id, definition),
  }));
  const toolDefinitions: LlmToolDefinition[] = definitions.map((item) => ({
    id: item.id,
    description: item.definition.description,
    inputSchema: item.schema,
  }));
  const messages: ModelMessage[] = [
    ...system.map((content) => ({ role: "system", content }) as const),
    ...input.messages,
  ];
  const log = Effect.runPromiseWith(yield* Effect.context<never>());
  const output = input.outputSchema
    ? Output.object({ schema: jsonSchema(input.outputSchema) })
    : undefined;

  const common = {
    // Preserve local-tool loop ownership (packages/agent/src/session/):
    //
    // prompt.ts: outer loop
    //   |  Read persisted messages; decide whether another step is needed
    //   v
    // processor.process() -> llm.stream() -> streamText(): ONE SDK step
    //   |                                     |
    //   |                              Execute tool callbacks
    //   |                                     |
    //   |<--------- tool-result / tool-error / finish-step events
    //   |
    //   |  Persist tool outcomes and step completion
    //   v
    // Return stop / continue to prompt.ts
    //   +-- stop -----> Exit
    //   +-- continue -> Re-read persisted messages at the top of the loop
    //
    // Our outer loop owns the next model request. The SDK must not feed tool
    // results into another model step before the processor persists them.
    // Provider-managed loops return a final finish, so the outer loop terminates.
    stopWhen: isStepCount(1),
    allowSystemInMessages: true,
    onError: ({ error }: { error: unknown }) =>
      log(Effect.logError("LLM stream error", { cause: error })),
    abortSignal: abort,
    maxRetries: input.retries ?? 0,
    model: languageModel,
    output,
    messages: ProviderTransform.message(
      messages,
      selectedModel.model,
      provider,
    ),
  };
  if (provider) {
    const { permissionMode } = yield* modelConfig.pipe(
      Effect.mapError((cause) => new ConfigurationUnavailable({ cause })),
    );
    yield* recordRequestSnapshot(input, {
      system,
      tools: toolDefinitions,
      toolChoice: undefined,
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    });
    const tools: ProviderTools = Object.fromEntries(
      definitions.map(({ id, definition, schema, validate }) => [
        id,
        {
          description: definition.description,
          inputSchema: providerToolInputSchema(schema),
          execute: (value: unknown, options: ProviderToolExecutionOptions) =>
            runToolCallback(definition, validate(value), options),
          toModelOutput: (output: unknown) =>
            (output as Tool.ExecuteResult).output.value,
        },
      ]),
    );
    const askPermission: ProviderPermissionAsk = (request) =>
      callbackRuntime.runPromise(
        Effect.suspend(() =>
          input.askPermission
            ? input.askPermission(request)
            : Effect.fail(new PermissionUnavailable()),
        ),
        abort,
      );
    const askQuestion: ProviderQuestionAsk = (request, { signal }) =>
      callbackRuntime.runPromise(
        Effect.suspend(() =>
          input.askQuestion
            ? input.askQuestion(request)
            : Effect.succeed({ type: "skipped" } as const),
        ),
        AbortSignal.any([abort, signal]),
      );
    const result = streamText({
      ...common,
      // Adapters emit exact tool outcomes themselves; delegate markers are
      // normalized below, after streamText has accounted for root steps.
      providerOptions: ProviderTransform.providerOptions(
        selectedModel.model,
        provider,
        {
          ...options,
          ...provider.requestOptions({
            cwd: input.cwd,
            tools,
            permissionMode,
            askPermission,
            askQuestion,
          }),
        },
      ),
    });
    return conformProviderStream<Tool.ExecuteResult>(result.stream);
  }

  const tools = Object.fromEntries(
    definitions.map(({ id, definition, schema, validate }) => [
      id,
      tool({
        description: definition.description,
        inputSchema: jsonSchema<ToolInput>(schema, {
          validate: (value) =>
            callbackRuntime.runPromise(
              validate(value).pipe(
                Effect.match({
                  onSuccess: (value) => ({ success: true as const, value }),
                  onFailure: (error) => ({ success: false as const, error }),
                }),
              ),
              abort,
            ),
        }),
        execute: (value, options) =>
          runToolCallback(definition, Effect.succeed(value), options),
      }),
    ]),
  );
  const toolChoice = shouldForceDirectAnswer(input.messages)
    ? "none"
    : undefined;
  yield* recordRequestSnapshot(input, {
    system,
    tools: toolDefinitions,
    toolChoice,
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  });
  const result = streamText({
    ...common,
    tools,
    toolChoice,
    temperature: input.agent.temperature,
    topP: input.agent.topP,
    // The SDK owns thinking-token accounting and provider model limits.
    maxOutputTokens: Math.min(
      selectedModel.model.limit?.output || MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    ),
    experimental_repairToolCall: (failed) => repairToolCall(tools, failed),
    headers: requestHeaders(input, selectedModel.model),
    providerOptions: ProviderTransform.providerOptions(
      selectedModel.model,
      provider,
      options,
    ),
  });
  return conformProviderStream<Tool.ExecuteResult>(result.stream);
});

/**
 * Clones a request snapshot so later mutations cannot change recorded diagnostics.
 * @example
 * const snapshot = buildRequestSnapshot({system: ['Instructions'], tools: []});
 */
function buildRequestSnapshot(input: LlmRequest): LlmRequest {
  return structuredClone(input);
}

function recordRequestSnapshot<E, R>(
  input: StreamInput<E, R>,
  request: LlmRequest,
): Effect.Effect<void, E, R> {
  return input.recordRequestSnapshot
    ? input.recordRequestSnapshot(buildRequestSnapshot(request))
    : Effect.void;
}

// The caller owns model selection; LLM validates its requested variant once.
const validateSelection = Effect.fn("LLM.validateSelection")(function* (
  input: Pick<StreamInput, "user" | "model">,
) {
  const { model } = input;
  const variant = input.user.model.selectedVariant;
  if (variant !== undefined && !model.availableVariants?.includes(variant)) {
    return yield* Effect.fail(
      new VariantNotFound({
        providerID: model.providerID,
        modelID: model.id,
        variant,
      }),
    );
  }
  return { model, variant };
});

function buildSystemPrompt(
  input: Pick<StreamInput, "agent" | "system">,
): string[] {
  return [[input.agent.prompt, ...input.system].filter(Boolean).join("\n")];
}

function modelInputSchema(parameters: StreamTool["parameters"]): JSONSchema7 {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(parameters),
  );
  return {
    ...document.schema,
    ...(Object.keys(document.definitions).length
      ? { definitions: document.definitions }
      : {}),
  } as JSONSchema7;
}

function toolInputValidator(
  id: string,
  definition: Pick<StreamTool, "parameters" | "formatValidationError">,
) {
  const validate = Schema.decodeUnknownEffect(
    Schema.toEncoded(definition.parameters),
  );
  return Effect.fn("LLM.validateToolInput")((value: unknown) =>
    Schema.decodeUnknownEffect(ToolInput)(value).pipe(
      // Preserve model input for execution and transcript events. Only the
      // tool owner applies transformations and checks the decoded domain value.
      Effect.tap(validate),
      Effect.mapError(
        (cause) =>
          new InvalidToolArguments({
            toolID: id,
            cause,
            message: definition.formatValidationError
              ? definition.formatValidationError(cause)
              : `The ${id} tool was called with invalid arguments: ${cause}.\nPlease rewrite the input so it satisfies the expected schema.`,
          }),
      ),
    ),
  );
}

function requestHeaders(
  input: Pick<StreamInput, "headers">,
  model: AvailableModel,
): Record<string, string> {
  const headers: Record<string, string> =
    model.providerID === "anthropic" ? {} : { "User-Agent": "OpenChart/V2" };
  return { ...headers, ...input.headers };
}

/**
 * Preserves V1's exact-answer heuristic for requests that explicitly prohibit extra output.
 * @example
 * shouldForceDirectAnswer([{role: 'user', content: 'Reply exactly OK and nothing else'}]);
 */
function shouldForceDirectAnswer(messages: ModelMessage[]): boolean {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!last) return false;
  const text = (
    typeof last.content === "string"
      ? last.content
      : last.content.map((part) => ("text" in part ? part.text : "")).join("\n")
  )
    .trim()
    .toLowerCase();
  return (
    /\b(reply|respond|output|return)\b[\s\S]{0,80}\bexactly\b/.test(text) &&
    /\bnothing else\b/.test(text)
  );
}
