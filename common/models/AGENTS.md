# models

Standalone Node provider bindings and adapters. See [implementation](src/AGENTS.md)
and [model architecture](../../docs/architecture/models.md).

- No V1, Agent, server, app, platform, or Effect dependencies. Generic helpers
  belong in common/utils. Tests use Node/Vitest with file isolation.
- Each binding owns native discovery and its SDK. Construction performs no I/O;
  discovery never installs, updates, or starts login. Catalog data enriches only
  native models. No model API bindings or credentials.
- `server/models` composes bindings, resolves selections, caches discovery, and
  owns refresh/disposal. Do not add a shared registry or application lifecycle here.
- `model-tiers.ts` alone defines provider IDs, tier IDs, classification, and
  provider-local downward fallback; each provider's tier table lives in
  `src/providers/<id>/tiers.ts`. Registration does not establish availability.
- SDK handles borrow their binding's lifetime. Binding disposal is terminal and
  idempotent; pending discovery cannot return after disposal. Request cleanup
  never disposes the shared binding.
- CLI adapters accept complete authoritative history every call. Continuation
  hints must be bounded, disposable, and invisible to application sessions.
  Request callbacks never leak across calls; `native-provider.ts` declares them.
- `src/provider-protocol.ts` owns protocol schemas/types; `src/stream.ts` validates
  adapter output once. Architecture tests enforce package boundaries.
