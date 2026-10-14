# server

Owns application composition and transports. See
[architecture](../docs/architecture/code-organization.md).

<!-- HUMAN-ANNOTATION:START -->

Each service belongs in `<folder-name>/<folder-name>.ts`, which is the service
entry point for that directory.

Before changing code under `server/`, think carefully about whether Effect can
substantially simplify the work.
<!-- HUMAN-ANNOTATION:END -->

- `index.ts` alone composes root tRPC routes. Features export child routers;
  hosts choose ports. `createServer` returns an unbound server; `access` guards
  every request with one predicate (bound Host, trusted Origin, per-run bearer
  token); CORS answers that origin only.
- `runtime.ts` owns one application Layer/ManagedRuntime. Initialize before
  listening; dispose on startup failure. Shutdown closes HTTP, then runtime;
  owner-scoped fibers finish cleanup first. Procedures never construct services or Layers.
  Agent recovery repairs abandoned execution before queues wake; Scheduler
  background starts after it succeeds. Recovery failure blocks readiness.
- Server contracts use Effect Schema; applied migrations are frozen.
  Parse wire input once, execute Effect internally, expose ordinary values.
- `lib/trpc` owns shared context/builders; `lib/errors` owns public error policy
  for tRPC and SSE; never expose stacks or raw defects.
- `db` owns application SQLite. Stores use its connection or caller transaction;
  Database detects commits, Resource maps events, `events` delivers.
- `resources/catalog.ts` is shared by transports, tools, and prompts;
  `lib/resource` stays transport-independent.
- `agent` owns execution; `models` owns the scoped provider registry;
  `scheduler` owns dispatch of Schedule Resources; `workspace` owns file access;
  `config` owns settings.json; `notification` is a host capability; `proactive`
  offers next steps before the user asks.
- App imports only types from `contract.ts`; server never imports app/platform
  code.
