# models

Owns provider composition, selection, settings, setup, and native lifetimes.
See [model architecture](../../docs/architecture/models.md).

- Models directly owns common bindings; no intermediate registry API.
  Discovery contracts and tier mappings remain in common/models.
- `config.ts` owns the public Schema. Provider settings/refresh replace the
  ScopedRef state; defaults and permissions alone never rebuild it. One observer
  serializes replacement and publishes `models.changed`.
- Replacement may interrupt active requests. Invalid settings release old clients
  and fail lookups until corrected. In-flight lookups cannot return disposed state.
- Construction performs no I/O. Discover enabled bindings concurrently in registration
  order. List omits unavailable and failed providers; discover/getModel keep the
  provider/cause. Cache each provider's success for one hour; failures expire
  immediately. Model resolution and quota stay fresh.
- Inspect disabled providers. Resolve tiers downward within the selected provider;
  explicit SDK IDs match exactly. SDK access performs no discovery.
- `onboarding/` owns manifests, downloads, installation, and login. Desktop startup
  installs missing pinned runtimes in the background, including disabled providers.
  Bindings receive managed paths and native CLIs retain credentials.
- Setup refreshes only its provider and invalidates discovery. Output stays bounded
  and ephemeral. Scope awaits all cleanup and preserves failures.
- Missing models become ModelNotFound; initialization becomes ProviderInit.
  Programming/lifecycle violations remain defects.
