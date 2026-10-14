# Resource framework

A Resource is durable user data with pure state transitions. The same
definition drives the tRPC API, the Agent's generic `resource_*` tools, the
Agent prompt's Resource list, and live invalidation in the app. The framework
lives in `server/lib/resource`; each Resource lives in `server/resources/<name>/`.

The app currently registers three Resources in `server/resources/catalog.ts`:

| Resource                    | Owned state                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `workspace`                 | immutable canonical `root` of a registered folder (read-only; custom `register`/`forget`)        |
| `agent_schedule`            | `name`, `enabled`, `target` (an Agent prompt), `recurrence` (cron or once), managed `nextFireAt` |
| `agent_schedule_occurrence` | `scheduleId`, `agentRunId`, `fireAt`; read-only acceptance history written by the Scheduler      |

## Files of one Resource

```text
server/resources/<name>/
  schema.ts        Drizzle tables, constraints and FKs; persistence source of truth
  entity.ts        complete runtime Effect Schema: envelope + domain fields derived from columns
  store.ts         maps tables to the framework's Store contract inside a caller transaction
  resource.ts      the only public entry: defineResource({name, description, entity, store, ...})
  transitions/     optional custom operations (<action>.ts) when intrinsic CRUD is not enough
  errors.ts        optional Resource-owned typed failures
```

- **IDs** use `defineId(prefix, brand)` from `@openchart/identifier`; for
  example `defineId("ags", "AgentSchedule.ID")` produces `ags_…`.
- **Envelope**: `resourceEnvelopeColumns()` / `resourceEnvelopeChecks()` declare
  `id`, `revision`, `createdAt`, `updatedAt` in the table, and
  `envelopeFields(Id)` adds them to the entity. SQLite generates timestamps;
  transitions assign IDs and revisions.
- **Annotations**: `serverManaged(field)` hides a field from client writes (it
  is still readable); `listKey(field)` on a top-level scalar makes it a list
  filter (`filter: {scheduleId}`), exposed as `listKeys` to the Agent.
- **Write schemas**: `defineResource` derives `createSchema` and `updateSchema`
  by recursively omitting server-managed fields, so there is no second entity.
- **Store**: `load`, `list`, `insert`, `save`, `remove` over the caller's
  transaction, returning unparsed `Row`s (`{id, revision, createdAt, updatedAt,
body}`). Stores own SQL and child-table mapping, nothing else.

## Transitions

A transition is an input-bound `{resolve, apply}` program. `resolve` gathers
external facts before any transaction; `apply(tx, resolved)` runs inside one
database transaction and reads consistent state through `tx`.
`Transactor.run(transition)` executes `resolve -> db.transaction(tx => apply(tx, resolved))`.
Resolve failure opens no transaction; apply failures, defects and interruption
roll everything back.

`defineResource` binds the intrinsic operations as `resource.transitions`:
`get`, `list`, `listAll` (internal, follows every page), `create`, `patch` and
`remove`. Custom operations are declared with `Transition.make({input, resolve,
apply, kind?})` and registered through `defineResource({transitions: {name}})`;
the tRPC adapter derives a query for `kind: "query"` and a mutation otherwise.
Custom names cannot shadow intrinsic ones.

Composing transitions produces another transition, including across Resources.
Cross-Resource operations live in `server/resources/macros/` and are exposed
through `resources/macro-router.ts` (empty by default). Macros compose public
transitions and never touch SQL or stores.

## Writes, patches and lists

- `create` decodes the client body, assigns an ID and revision 1, and decodes the
  complete stored entity before commit; a decoding defect rolls back.
- `patch` takes RFC 6902 operations (all six) with RFC 6901 pointers and a
  required `expectedRevision`. Operations apply to a clone of the writable
  data; protected fields reject with `PatchRejected`; an invalid final value is
  `ResourceStateInvalid` with structured issues; a stale revision is
  `RevisionConflict`.
- `list` sorts by `createdAt` (default) or `updatedAt`, then ID, with
  `order: "asc" | "desc"`. Cursors are opaque base64url tokens bound to the same
  filter and order; deleted anchors stay valid. The default page size is 50.
- `readOnly: true` hides only the public intrinsic create/patch/delete. Get,
  list and custom transitions remain public; internal callers keep full access.

## Events and the app

The database detects committed root changes, including cascades, and
`lib/resource/events.ts` publishes `resource.changed {resource, id, revision}`
after commit over the shared SSE stream. Events are invalidations only: clients
refetch, and reconnects invalidate everything. App Query keys follow router
paths, e.g. `trpc.resources.agent_schedule.list(...)` caches under
`[['resources', 'agent_schedule', 'list'], {input}]`.

## Agent access

`resource_read`, `resource_mutate` and `resource_search` derive their schemas
from the catalog. Reads can include the entity JSON schema and `listKeys`;
mutations expose only intrinsic create/patch/delete and reject read-only
Resources; every call asks permission first. The analyst prompt lists each
Resource's `name` and `description`, so write descriptions for the model.
Dedicated tools (such as `create_schedule`) may call transitions directly.

## Adding a Resource

1. Create `server/resources/<name>/schema.ts` with a `sqliteTable` using
   `resourceEnvelopeColumns()` and `resourceEnvelopeChecks("<name>", table)`.
   Only `schema.ts` may import another Resource's `schema.ts`, and only for FKs.
2. Create `entity.ts`: derive fields with `createSelectSchema` from
   `drizzle-orm/effect-schema`, refine them with Effect Schema, and export
   `Schema.Struct({...envelopeFields(Id), ...domain})`.
3. Create `store.ts` implementing `Store<StoreBody<typeof Entity>>`; reuse
   `listWindowSql` from `lib/resource/pagination-sql` for `list`.
4. Create `resource.ts` with `defineResource({name, description, entity, store})`
   and register it in `server/resources/catalog.ts`.
5. Run `just migration <name>` to generate one forward migration and refresh
   `server/db/schema.gen.ts` / `migration.gen.ts`. Never edit an applied migration.
6. In the app, read and write through `transport.rpc.resources.<name>.*` with
   React Query; `subscribeResourceInvalidation` already refreshes queries.
7. Add tests beside the Resource (`resource.test.ts`) using an in-memory database.

`server/resources/agent-schedule/` is a complete example, including a managed
field (`nextFireAt`) computed by its store and a backend-only custom transition
(`advanceSchedule`). `server/resources/workspace/` shows a read-only Resource
with custom `register`/`forget` transitions whose resolve phase touches disk.
