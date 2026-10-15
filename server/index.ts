// Purpose: Compose the runtime and the tRPC server.

import { timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { agentRouter } from "@openchart/server/agent";
import { faviconRouter } from "@openchart/server/favicon/router";
import { eventsRouter } from "@openchart/server/events";
import { trpc } from "@openchart/server/lib/trpc";
import { resourceRouter } from "@openchart/server/resources/router";
import { workspaceRouter } from "@openchart/server/workspace/router";
import { modelsRouter } from "@openchart/server/models/router";
import { configRouter } from "@openchart/server/config/router";
import { schedulerRouter } from "@openchart/server/scheduler/router";
import { proactiveRouter } from "@openchart/server/proactive/router";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { Schema } from "effect";

import {
  echo,
  makeRuntime,
  type RuntimeOptions,
  type Runtime,
} from "./runtime";

/** Root tRPC routes. Do not create raw routes here, echo is the only exception for debugging purpose. */
export const router = trpc.router({
  favicon: faviconRouter,
  events: eventsRouter,
  agent: agentRouter,
  resources: resourceRouter,
  config: configRouter,
  scheduler: schedulerRouter,
  proactive: proactiveRouter,
  models: modelsRouter,
  workspace: workspaceRouter,
  echo: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String }), {
        parseOptions: { onExcessProperty: "error" },
      }),
    )
    .query(({ ctx, input }) => ctx.runtime.runPromise(echo(input.message))),
});

/** tRPC client contract. */
export type AppRouter = typeof router;

/** Build an HTTP handler over a caller-owned runtime; the host awaits runtime.context() before listening.
 * @example const server = createHttpServer(createRequestHandler(runtime));
 */
export function createRequestHandler(runtime: Runtime) {
  return createHTTPHandler({
    allowMethodOverride: true,
    basePath: "/trpc/",
    router,
    createContext: () => ({ runtime }),
    // tRPC replaces Node's Vary header; appending here is the only way to keep it.
    responseMeta: () => ({ headers: new Headers({ vary: "Origin" }) }),
  });
}

/** Local API access policy: one trusted renderer origin and one per-run secret. */
export interface LocalAccess {
  /** Every request presents it as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** The only Origin allowed to call the API; CORS answers apply to it alone. */
  readonly origin: string;
}

/** How the host process exposes the runtime; {@link RuntimeOptions} configures the runtime itself. */
export interface ServerOptions {
  /** Guards every request; absent leaves the loopback API open (browser development, tests). */
  readonly access?: LocalAccess;
}

/**
 * One predicate for every HTTP request, including SSE: Host must be the bound
 * `127.0.0.1:<port>` (defeats DNS rebinding), Origin must be the trusted renderer,
 * and the bearer token must match. Preflight cannot carry credentials, so OPTIONS
 * passes on Host and Origin alone.
 */
function localAccess(server: Server, access: LocalAccess) {
  const secret = Buffer.from(access.token);
  const authorized = (request: IncomingMessage): boolean => {
    const address = server.address();
    if (typeof address !== "object" || address === null) return false;
    if (request.headers.host !== `127.0.0.1:${address.port}`) return false;
    if (request.headers.origin !== access.origin) return false;
    if (!URL.parse(request.url ?? "/", "http://localhost")) return false;
    if (request.method === "OPTIONS") return true;
    const bearer = request.headers.authorization;
    const presented = Buffer.from(
      bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : "",
    );
    return (
      presented.length === secret.length && timingSafeEqual(presented, secret)
    );
  };
  return { origin: access.origin, authorized };
}

/**
 * Initialize application services and create an unbound host. Use shutdown() to release all owned resources.
 * With `host.access`, every request must present the bound Host, the
 * trusted Origin, and the token; failures answer 401 before any routing happens.
 * @example
 * const server = await createServer({home: '/tmp/endo'}, {access: {token, origin: 'endo://app'}});
 * server.listen(0, '127.0.0.1');
 */
export async function createServer(
  options: RuntimeOptions,
  host: ServerOptions = {},
) {
  const runtime = makeRuntime(options);
  try {
    await runtime.context();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const handle = createRequestHandler(runtime);
  const server = createHttpServer();
  const access = host.access && localAccess(server, host.access);
  server.on("request", (request, response) => {
    if (access) {
      if (!access.authorized(request)) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", access.origin);
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response
          .writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type",
            Vary: "Origin",
          })
          .end();
        return;
      }
    }
    const url = URL.parse(request.url ?? "/", "http://localhost");
    if (!url) {
      response.writeHead(400).end();
      return;
    }
    if (url.pathname.startsWith("/trpc/")) {
      handle(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  return Object.assign(server, {
    /**
     * Closes HTTP, then the runtime, even when closing HTTP fails.
     * @example await server.shutdown();
     */
    async shutdown(): Promise<void> {
      try {
        const closed = server.listening
          ? new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            })
          : Promise.resolve();
        server.closeAllConnections();
        await closed;
      } finally {
        await runtime.dispose();
      }
    },
  });
}
