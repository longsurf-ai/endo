# models implementation

Root is the provider-agnostic protocol: schemas, the `ModelProvider` and
`NativeProvider` contracts, stream normalization, catalog, tier algorithms, and
transforms that take a `NativeProvider` parameter. Everything provider-specific
lives in [providers/](providers/AGENTS.md); root never imports it (architecture test).
See [protocol.md](protocol.md) and [architecture](../../../docs/architecture/models.md).

- model-provider schemas expose native metadata, never credentials or transport.
  Unknown capabilities/costs/limits/variants stay unknown; false/zero/empty are facts.
  Bindings own availability; model-tiers.ts owns classification, ordering, and
  provider-local downward fallback over each provider's own tier table.
- Transforms never mutate resolved selections. Merge defaults
  < explicit options < variant; fail missing translations before I/O. Sampling
  defaults stay provider-owned; explicit native options override reasoning mapping.
- Bindings own product policy, discovery results and request MCP/permission
  closures. The host supplies explicit managed executable paths and owns versions
  and installation in server/models/onboarding. Adapters own native translation.
  Never repair adapter envelopes in middleware.
  Preserve native auth/config behavior; config isolation requires its own design.
  Exception: the Antigravity adapter adds one fixed MCP relay and its allow rules
  to the CLI's own config, because the CLI reads MCP servers only from there.
- `provider-tools.ts` defines host tools for native loops. Adapters execute them
  in-process and emit the exact outcome as the tool result; nothing is restored later.
- `provider-protocol.ts` owns metadata, delegate, and native-result schemas/types,
  plus the adapter-side metadata and delegate-step builders adapters share.
  `stream.ts` validates once, removes transport markers, and unifies native outputs;
  ModelStreamEvent consumers trust that type.
  `protocol.md` describes ordering; proxy results never supply child content.
- Catalog enriches exact native matches; parse before caching. Failed loads clear
  the memoized promise so the next read can retry. No timer.
- Preserve JSON Schema structure; SDKs own schema conversion.
- `provider-quota.ts` owns plan quota schemas. Bindings translate native reads;
  quota never feeds discovery, selection, or caches.
- Never synthesize cache keys/breakpoints. Cost tiers retain catalog thresholds;
  usage counts per-call input plus cache-read, output includes reasoning.
