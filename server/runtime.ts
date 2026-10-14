// Purpose: Owns the server-lifetime Effect Layer and ManagedRuntime.

import path from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Home } from "./home";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import * as ResourceEvents from "@openchart/server/lib/resource/events";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { PluginRegistry } from "@openchart/server/agent/plugin/registry";
import { Permission } from "@openchart/server/agent/permission";
import { Question } from "@openchart/server/agent/question";
import { Session } from "@openchart/server/agent/session";
import { ToolRegistry } from "@openchart/server/agent/tool/registry";
import { LLM } from "@openchart/server/agent/llm";
import { Models } from "@openchart/server/models";
import { Scheduler } from "@openchart/server/scheduler";
import { Notification } from "@openchart/server/notification";
import {
  layerFromFile,
  layerFromProvider,
} from "@openchart/server/config/provider";
import { WorkspacesLayer } from "@openchart/server/workspace/workspace";
import { ensureDefaultWorkflows } from "@openchart/server/agent/workflow/defaults";
import { agentLayer } from "./agent";
import { layer as schedulerBackgroundLayer } from "./scheduler/background";
import * as Agui from "./agent/publisher/agui/adapter";
import { Database } from "./db/database";
import * as Events from "./events/events";

/** Options that select process-owned resources for one server runtime. */
export interface RuntimeOptions {
  /** Host-selected profile directory for SQLite, settings, cache and workspaces. */
  readonly home: string;
  /** Tests may replace only SQLite with an in-memory database. */
  readonly databasePath?: ":memory:";
  /** Host-owned system notifications; without it, notifications are only logged. */
  readonly notify?: Notification.Notify;
  /** Native config source; otherwise watch settings.json under home. */
  readonly config?: ConfigProvider.ConfigProvider;
  /** Catalog and managed-runtime startup overrides; provider discovery remains lazy. */
  readonly models?: Partial<
    Omit<Models.Options, "cacheDirectory" | "runtimeDirectory">
  >;
  /** Profile configuration shared by prompt execution and permission evaluation. */
  readonly profiles?: AgentProfile.Configuration;
}

function makeDatabaseLayer(root: string, options: RuntimeOptions) {
  const filename = options.databasePath ?? path.join(root, "openchart.sqlite3");
  return Layer.unwrap(
    Effect.map(Events.Service, (events) =>
      Database.layer(filename, ResourceEvents.makeOnCommitted(events)),
    ),
  ).pipe(Layer.provideMerge(Events.layer));
}

function makeAgentLayer(
  root: string,
  options: RuntimeOptions,
  database: ReturnType<typeof makeDatabaseLayer>,
) {
  const models = Models.layer({
    cacheDirectory: path.join(root, ".cache", "models"),
    runtimeDirectory: path.join(root, "model-providers"),
    fetchEnabled: true,
    userAgent: "Reagent/1",
    ...options.models,
  });
  const services = Layer.mergeAll(
    Permission.layer,
    Question.layer,
    ToolRegistry.layer,
    // Bind feature plugins with Plugin.bind and pass them here, in catalog order.
    PluginRegistry.layer([]),
    LLM.layer.pipe(Layer.provideMerge(models)),
  ).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(ensureDefaultWorkflows()).pipe(
        Layer.provideMerge(WorkspacesLayer),
        Layer.provideMerge(database),
      ),
    ),
    Layer.provideMerge(
      Layer.merge(
        Agui.layer.pipe(
          Layer.provideMerge(Layer.merge(database, Session.layer)),
        ),
        AgentProfile.layer(options.profiles ?? {}),
      ),
    ),
  );
  return agentLayer.pipe(Layer.provideMerge(services));
}

function makeConfigLayer(root: string, options: RuntimeOptions) {
  return options.config
    ? layerFromProvider(options.config)
    : layerFromFile(path.join(root, "settings.json")).pipe(
        Layer.provide(Events.layer),
      );
}

function makeApplicationLayer(options: RuntimeOptions) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const { root } = yield* Home;
      const database = makeDatabaseLayer(root, options);
      const application = Layer.mergeAll(
        Scheduler.layer,
        Notification.layer(options.notify),
        makeAgentLayer(root, options, database),
      ).pipe(
        Layer.provideMerge(WorkspacesLayer),
        Layer.provideMerge(database),
        Layer.provideMerge(Events.layer),
        Layer.provideMerge(makeConfigLayer(root, options)),
      );
      // Background fibers sit above every dependency, so shutdown interrupts and
      // joins them first.
      return schedulerBackgroundLayer.pipe(Layer.provideMerge(application));
    }),
  ).pipe(
    Layer.provideMerge(
      Home.layer(options.home).pipe(Layer.provideMerge(NodeFileSystem.layer)),
    ),
  );
}

/**
 * Creates the shared Effect runtime used by one V2 server instance.
 *
 * The runtime builds its services and background fibers lazily and shares them
 * across requests. Hosts await runtime.context() before accepting traffic so
 * background work starts without a request. Disposal interrupts and awaits the
 * background fibers before releasing their service dependencies.
 *
 * @param options - Process-owned resource configuration.
 * @returns A managed runtime containing every server application service.
 *
 * @example
 * ```ts
 * const runtime = makeRuntime({home: '/tmp/openchart-test', databasePath: ':memory:'});
 * try {
 *   await runtime.context();
 * } finally {
 *   await runtime.dispose();
 * }
 * ```
 */
export function makeRuntime(options: RuntimeOptions) {
  return ManagedRuntime.make(makeApplicationLayer(options));
}

/** The managed Effect runtime owned by one V2 server instance. */
export type Runtime = ReturnType<typeof makeRuntime>;

/** Return a message through the shared runtime. @example yield* echo('hello'); */
export function echo(message: string) {
  return Effect.succeed({ message });
}
