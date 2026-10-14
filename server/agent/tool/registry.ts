// Purpose: Constructs the local Agent tool catalog and exposes its initialized definitions.

import { ResourceReadTool } from "@openchart/server/agent/tool/tools/resource-read";
import { ResourceMutateTool } from "@openchart/server/agent/tool/tools/resource-mutate";
import { ResourceSearchTool } from "@openchart/server/agent/tool/tools/resource-search";
import { EchoTool } from "@openchart/server/agent/tool/tools/echo";
import { WorkflowTool } from "@openchart/server/agent/tool/tools/workflow";
import { TaskTool } from "@openchart/server/agent/tool/tools/task";
import { ReadTranscriptTool } from "@openchart/server/agent/tool/tools/read-transcript";
import { SearchTranscriptTool } from "@openchart/server/agent/tool/tools/search-transcript";
import { CreateScheduleTool } from "@openchart/server/agent/tool/tools/create-schedule";
import { Context, Effect, Layer, Record, type Schema } from "effect";
import * as Tool from "./tool";

// Every registered tool is declared here; all catalog views derive from this list.
const builtin = {
  echo: EchoTool,
  workflow: WorkflowTool,
  task: TaskTool,
  resource_read: ResourceReadTool,
  resource_mutate: ResourceMutateTool,
  resource_search: ResourceSearchTool,
  read_transcript: ReadTranscriptTool,
  search_transcript: SearchTranscriptTool,
  create_schedule: CreateScheduleTool,
};

type Builtin = (typeof builtin)[keyof typeof builtin];
type InitializationError = Effect.Error<Builtin>;
type ExecutionServices =
  Effect.Success<Builtin> extends Tool.Info<
    Schema.Decoder<unknown>,
    Tool.Metadata,
    unknown,
    infer R
  >
    ? R
    : never;
type Definition = Tool.Def<
  Schema.Decoder<unknown>,
  Tool.Metadata,
  unknown,
  ExecutionServices
>;

/** Tool discovery; callers bind invocation context when executing a definition. */
export interface Interface {
  /**
   * Lists the registered tool IDs in catalog order.
   * @example
   * const ids = yield* registry.ids();
   */
  readonly ids: () => Effect.Effect<string[], InitializationError>;
  /**
   * Returns a new array containing the service's initialized tool definitions.
   * @example
   * const definitions = yield* registry.all();
   */
  readonly all: () => Effect.Effect<Definition[], InitializationError>;
}

/**
 * Effect service for the local tool catalog.
 * @example
 * const registry = yield* ToolRegistry.Service;
 * const ids = yield* registry.ids();
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/ToolRegistry",
) {}

/**
 * Constructs tools once per service and initializes them lazily on first lookup.
 * All lookups share those definitions; no lookup executes a tool. The owning
 * Layer scope must outlive every invocation that borrows its definitions.
 * @example
 * const ids = yield* Service.use(registry => registry.ids()).pipe(
 *   Effect.provide(ToolRegistry.layer),
 * );
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const setup = yield* Effect.all(builtin);

    const initialized = Record.map(
      setup,
      (
        info: Tool.Info<
          Schema.Decoder<unknown>,
          Tool.Metadata,
          InitializationError,
          ExecutionServices
        >,
      ) => Tool.init(info),
    );

    // Catalog state belongs to this service, never to an invocation or Session.
    const state = yield* Effect.cached(
      Effect.all(initialized).pipe(Effect.withSpan("ToolRegistry.state")),
    );

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* state;
      return Object.values(s);
    });

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id);
    });

    return Service.of({ ids, all });
  }),
);

export * as ToolRegistry from "./registry";
