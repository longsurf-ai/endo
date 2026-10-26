# Code organization

Endo is a bare-bones desktop framework for agentic apps. It separates the
platform-independent app, the server, the Electron host, and shared packages.
Resource ownership follows [resource.md](resource.md).

## Repository

```text
endo/
  justfile                    every developer command (install, desktop, check, migration, …)
  package.json, bun.lock      one Bun workspace
  app/                        shared React app (renderer); no Electron imports
  server/                     Effect + tRPC application server
  common/
    agent/                    composer Part constraints and directive syntax
    identifier/               branded ID schemas (defineId) and monotonic generation
    models/                   Node-only native model providers (Codex, Claude Code, Antigravity, Grok, OpenCode)
    notification/             notification sound catalog shared by app, server and desktop
    utils/                    lowest-level helpers
  platform/desktop/           Electron main, preload, backend entry, packaging
  demo/agent/                 headless backend for Agent work without Electron
  docs/architecture/          design contracts
```

```text
platform/desktop ─────> app
app ──────────────────> common
server ───────────────> common
platform/* ───────────> common
app - - - - - - - - -> server          (AppRouter types only)
```

The AppRouter edge goes through `@openchart/server/contract`, a types-only
export that runtime code cannot load. It exists only in
`app/src/lib/transport/transport.ts`.

## Server

```text
server/
  index.ts                    composition root: tRPC router, local access guard, createServer
  runtime.ts                  one Effect Layer + ManagedRuntime for every service
  context.ts, contract.ts     shared tRPC context; type-only client contract
  home.ts                     the profile directory (<home>/openchart.sqlite3, settings.json, workspaces/)
  db/                         SQLite, the migration stream, change detection
  events/                     typed process-local notifications + tRPC SSE adapter
  lib/
    resource/                 defineResource, Transition, Transactor, patch, pagination, events
    trpc/                     shared router builder and the derived Resource routers
    errors/                   the single public error classifier
  resources/
    catalog.ts                resources[] shared by HTTP, Agent tools and prompts
    router.ts, macro-router.ts
    macros/                   cross-Resource transitions (none yet)
    workspace/, agent-schedule/, agent-schedule-occurrence/
  agent/                      the Agent runtime (see agent.md)
  models/                     provider registry, settings and managed CLI installation
  scheduler/                  dispatches due Schedules through Agent admission
  workspace/                  file access, observation and CAS writes for registered folders
  config/                     settings.json ownership and public settings
  notification/               host notification capability
  proactive/                  starter prompt suggestions for an empty chat
  favicon/                    optional website icons for chat citations
```

`server/index.ts` mounts `events`, `agent`, `resources`, `config`, `scheduler`,
`proactive`, `models`, `workspace`, `favicon` and a debugging `echo`. Every
procedure parses wire input once and performs one `runtime.runPromise`; Effect
values never cross the tRPC contract. `await createServer(options)` builds the
runtime and background services, then returns an unbound HTTP server whose
`shutdown()` closes HTTP and then the runtime.

`runtime.ts` composes: Database (+ Resource change events), Events, Config,
Workspaces, Models + LLM, Agent profiles, tools, permissions, questions, the
plugin registry (empty), Session and the AG-UI publisher, the Agent itself,
Scheduler and its background loop, and Notification. `ensureDefaultWorkflows`
seeds `workflows/*.workflow.ts` into the default Workspace at startup.

## Agent

`server/agent` owns durable admission and process-local execution; `prompt` is
the single entry point. Tools registered in `agent/tool/registry.ts`: `echo`,
`workflow`, `task`, `resource_read`, `resource_mutate`, `resource_search`,
`read_transcript`, `search_transcript`, `create_schedule`. The `analyst`
profile allows all of them; its prompt is compiled from
`agent/profiles/prompt/segments/{identity,communication,resources,schedules}.txt`.
Slash commands live in `agent/command/` (`compact`, `best-of-n`,
`multi-turn-debate`, `thesis-killer`, `hypothesis-race`). See
[agent](agent.md), [workflow](workflow.md), [commands](commands.md),
[permission](permission.md), [plugins](agent-plugins.md) and [models](models.md).

To add a tool: define it with `Tool.define` in `agent/tool/tools/`, register it
in `agent/tool/registry.ts`, and allow it in `agent/profiles/builtin.ts`.

## App

```text
app/src/
  bootstrap.tsx               mounts App with the Desktop connection and AppHost
  app/
    router.tsx                routes: chat, sessions/:id, schedule, workspaces, settings/*
    layout.tsx                sidebar, Copilot panel, shared Agent and connection lifetime
    left-sidebar/             New Chat, Schedule, Workspace, Settings, Chats list
    agent/                    FullPageAgent and Copilot placement
    schedule/                 Schedule page, prompt editor and creation menu
    workspace/                Workspace page and AI file merge
    routes/settings/          Appearance, Models, Changelog
    connection/               transport, reconnect and invalidation observers
    trellis/                  onboarding host, device-local progress and agent-connection workflow
  features/
    agent/                    chat UI and assistant-ui adapters
    schedule/                 Schedule/Occurrence queries and components
    workspace/                file tree, Dockview tabs, Monaco/Milkdown/PDF/Office viewers
  lib/
    agent/                    shared Agent client, Query, SessionStore and hooks
    transport/                the single tRPC/SSE connection
    resource/                 Resource invalidation and references
    workspace/                Workspace queries, mutations and observation
    config/, theme/, host/, monaco/, proactive/, prompt-converter/, react-query/, unsaved-changes/
  components/ui, components/layouts, hooks, stores, styles, utils
```

Features never import each other; `app/` composes them. Server data stays in
React Query; Resource invalidation over SSE refreshes it. `useAgent` is mounted
once per transport and shared through `AgentProvider`. See
[app/AGENTS.md](../../app/AGENTS.md) and [app/DESIGN.md](../../app/DESIGN.md).

## Database and migrations

Each Resource's `schema.ts` and `agent/**/schema.ts` declare their tables;
`db/drizzle.config.ts` collects them. `just migration <name>` diffs the schema
union against `db/schema.json`, writes one `db/migration/<timestamp>_<name>.ts`,
and regenerates `migration.gen.ts` and `schema.gen.ts`. A fresh database runs
the generated full schema and marks every migration applied; existing databases
apply the pending suffix, validated against a checksum ledger. The history was
squashed into a single `initial` migration when this framework was carved out.

## Checks

`just check` runs schema drift validation, lint, formatting, every workspace
typecheck and all tests (core Vitest project, app jsdom and Node projects, and
tooling tests) in parallel. One ESLint flat config enforces dependency
boundaries; Prettier owns formatting.
