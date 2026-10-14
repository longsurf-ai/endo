# events

Owns typed process-local delivery and generic tRPC SSE. Definitions stay with
features; canonical state stays with its domain/database owner.

- Publish typed definitions. No central hand-written manifest, durable log,
  replay, aggregate sequence, projector, or SQL change collection.
- Resource maps committed database changes into events; runtime injects that
  callback. Database owns timing without importing Events; Events imports no Database.
- `allBounded` is the sole subscription API over one scoped PubSub. It registers
  before returning, preventing gaps between subscription and snapshot reads.
  No per-type or unbounded channels.
- Observers see only events published while subscribed. Overflow fails explicitly;
  never silently drop invalidations. Subscriber failure cannot fail publishers.
- `router.ts` alone adapts the stream to SSE and imports no concrete definitions.
  Send ready after registration, then event envelopes with unknown data. Readiness
  is not a replay cursor.
- `withBarrier` coordinates committed publication, observer registration, and
  snapshot cuts. Never nest it or hold it during model/user waits. It owns no
  domain state or transaction logic.
- `make` builds one isolated instance; backend-only [bus](../bus/AGENTS.md) reuses it. Never bridge them.
