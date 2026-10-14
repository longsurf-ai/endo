// Purpose: Defines Effect-based Agent tools and their initialization and argument-decoding boundary.

export * as Tool from "./tool";

import type { WithParts } from "@openchart/server/agent/contracts/message";
import type {
  EvidenceCandidates,
  FilePart,
  ToolModelOutput,
} from "@openchart/server/agent/contracts/part";
import { Effect, Schema } from "effect";
import { InvalidArgumentsError } from "./errors";

/** Serializable execution details, independent of model output and UI schemas. */
export type Metadata = Schema.JsonObject;

/** Tool-authored permission intent; the host supplies request identity and policy. */
export interface PermissionRequest {
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly metadata: Metadata;
  readonly always: readonly string[];
}

/**
 * Host-owned context for one invocation. The host must persist the matching
 * ToolPart before execution. Cancellation follows the invoking Effect fiber;
 * native APIs use the signal supplied by Effect.tryPromise or Effect.promise.
 * Callbacks belong to this invocation and must not be cached during tool setup.
 */
export interface Context<M extends Metadata = Metadata, R = never> {
  /** Accepted root execution; child invocations retain their own Session and author. */
  readonly rootRunID: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly callID: string;
  readonly agent: string;
  readonly messages: readonly WithParts[];
  /**
   * Reports progress for the current ToolPart; failures propagate to the caller.
   * @example
   * yield* ctx.metadata({title: 'Reading data'});
   */
  readonly metadata: (input: {
    title?: string;
    metadata?: M;
    /** Adds direct delegate links before execution; existing links are retained. */
    childSessionIds?: readonly string[];
  }) => Effect.Effect<void, unknown, R>;
  /**
   * Waits for host authorization. A refusal fails the Effect; interruption cancels
   * the wait. The host owns the concrete permission error and persistence protocol.
   * @example
   * yield* ctx.ask({permission: 'read', patterns: ['/notes'], always: [], metadata: {}});
   */
  readonly ask: (input: PermissionRequest) => Effect.Effect<void, unknown, R>;
}

/** A tool supplies file content; the host assigns Part identity and ownership. */
export type Attachment = Omit<FilePart, "id" | "messageID">;

/**
 * One authored outcome. Model content stays structured through execution;
 * evidence and attachments are materialized by the host, outside this module.
 */
export interface ExecuteResult<M extends Metadata = Metadata> {
  readonly title: string;
  readonly metadata: M;
  readonly output: ToolModelOutput;
  readonly evidence?: EvidenceCandidates;
  readonly attachments?: readonly Attachment[];
}

/**
 * An initialized tool that decodes untrusted input before execution.
 * Widening a definition must preserve its execution requirements.
 */
export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
  E = unknown,
  out R = never,
> {
  readonly id: string;
  readonly description: string;
  /** The sole parameter contract; provider schemas must be derived from it. */
  readonly parameters: Parameters;
  /**
   * Decodes untrusted input once before running the authored implementation.
   * The caller owns ToolPart persistence, permission policy, and the execution Scope.
   * @example
   * const result = yield* definition.execute({query: 'AAPL'}, context);
   */
  readonly execute: <RContext>(
    args: unknown,
    ctx: Context<M, RContext>,
  ) => Effect.Effect<ExecuteResult<M>, E | InvalidArgumentsError, R | RContext>;
  /**
   * Customizes only parameter-decoding feedback; implementation failures bypass it.
   * @example
   * const detail = definition.formatValidationError?.(schemaError);
   */
  readonly formatValidationError?: (error: Schema.SchemaError) => string;
}

/** An authored tool whose implementation receives only decoded arguments. */
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
  E = unknown,
  R = never,
> = Omit<Def<Parameters, M, E, R>, "id" | "execute"> & {
  /**
   * Runs with arguments decoded by the wrapper using the parameter schema.
   * @example
   * execute: ({count}, ctx) => Effect.succeed({
   *   title: 'Count', metadata: {}, output: {type: 'json', value: count},
   * })
   */
  execute(
    args: Parameters["Type"],
    ctx: Context<M, R>,
  ): Effect.Effect<ExecuteResult<M>, E, R>;
};

/** A constructed tool with a repeatable initialization step and stable identity. */
export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
  E = unknown,
  out R = never,
> {
  readonly id: string;
  /**
   * Creates a fresh wrapped definition without executing the tool.
   * The named Def preserves covariant execution requirements during widening.
   * @example
   * const definition = yield* info.init();
   */
  readonly init: () => Effect.Effect<Def<Parameters, M, E, R>, E>;
}

type Init<
  Parameters extends Schema.Decoder<unknown>,
  M extends Metadata,
  E,
  R,
> =
  | DefWithoutID<Parameters, M, E, R>
  | (() => Effect.Effect<DefWithoutID<Parameters, M, E, R>, E>);

/** Resolves the initialized definition type from an Info or its construction Effect. */
export type InferDef<T> =
  T extends Effect.Effect<infer Value, unknown, unknown>
    ? InferDef<Value>
    : T extends Info<infer P, infer M, infer E, infer R>
      ? Def<P, M, E, R>
      : never;

/** Extracts decoded argument types from an Info or its construction Effect. */
export type InferParameters<T> = InferDef<T>["parameters"]["Type"];

/** Extracts execution metadata from an Info or its construction Effect. */
export type InferMetadata<T> = Effect.Success<
  ReturnType<InferDef<T>["execute"]>
>["metadata"];

/**
 * Creates the repeatable Info.init callback, adding decoding and tracing to
 * the authored execution function.
 *
 * ```text
 * createInitializer(id, initialize) -> info.init callback
 *
 * Each evaluation of info.init():
 *   definition or initialize() -> prepare decoder -> wrapped definition
 *
 * Wrapped execute(unknown, ctx), inside the Tool.execute span:
 *   decode once using definition.parameters
 *     |-- failure -> InvalidArgumentsError
 *     `-- success -> authored execute(decoded, ctx) -> unchanged result
 * ```
 *
 * Creating the callback runs no initialization; initialization runs no tool.
 * Only decoding failures are mapped. Authored failures, defects, and
 * interruption propagate unchanged.
 */
function createInitializer<
  Parameters extends Schema.Decoder<unknown>,
  M extends Metadata,
  E,
  R,
>(
  id: string,
  initialize: Init<Parameters, M, E, R>,
): Info<Parameters, M, E, R>["init"] {
  return () =>
    Effect.gen(function* () {
      const definition =
        typeof initialize === "function" ? yield* initialize() : initialize;
      const decode = Schema.decodeUnknownEffect(definition.parameters);
      return {
        ...definition,
        id,
        execute: <RContext>(args: unknown, ctx: Context<M, RContext>) =>
          Effect.gen(function* () {
            // Model projections cannot express every schema constraint. Only the
            // owning decoder may supply arguments to the implementation.
            const decoded = yield* decode(args).pipe(
              Effect.mapError(
                (error) =>
                  new InvalidArgumentsError({
                    tool: id,
                    detail: definition.formatValidationError
                      ? definition.formatValidationError(error)
                      : String(error),
                  }),
              ),
            );
            // Host callbacks add requirements to this invocation without binding
            // either their services or the tool's services during initialization.
            const execute: DefWithoutID<
              Parameters,
              M,
              E,
              R | RContext
            >["execute"] = definition.execute;
            return yield* execute(decoded, ctx);
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": id,
                "session.id": ctx.sessionID,
                "message.id": ctx.messageID,
                "tool.call_id": ctx.callID,
              },
            }),
          ),
      };
    });
}

/**
 * Constructs a tool using OpenChart's Effect setup followed by repeatable init.
 * Setup and execution retain their own service requirements. Host callback
 * requirements flow through each invocation. Construction is lazy, and the
 * stable id is available before setup runs. No runtime is started.
 * @example
 * const parameters = Schema.Struct({query: Schema.String});
 * const Lookup = Tool.define('lookup', Effect.succeed({
 *   description: 'Look up a value',
 *   parameters,
 *   execute: ({query}: typeof parameters.Type) => Effect.succeed({
 *     title: query, metadata: {}, output: {type: 'text', value: query},
 *   }),
 * }));
 * const definition = yield* Tool.init(yield* Lookup);
 */
export function define<
  Parameters extends Schema.Decoder<unknown>,
  M extends Metadata,
  RSetup,
  E = never,
  R = never,
  ID extends string = string,
>(
  id: ID,
  setup: Effect.Effect<Init<Parameters, M, E, R>, E, RSetup>,
): Effect.Effect<Info<Parameters, M, E, R>, E, RSetup> & { readonly id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const initialize = yield* setup;
      return { id, init: createInitializer(id, initialize) };
    }),
    { id },
  );
}

/**
 * Initializes a constructed tool with its stable id and decoded-input wrapper.
 * Each evaluation initializes afresh; this function does not cache or execute it.
 * @example
 * const definition = yield* Tool.init(info);
 * const result = yield* definition.execute({query: 'AAPL'}, context);
 */
export function init<
  P extends Schema.Decoder<unknown>,
  M extends Metadata,
  E,
  R,
>(info: Info<P, M, E, R>): Effect.Effect<Def<P, M, E, R>, E> {
  return info.init();
}
