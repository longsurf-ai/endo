# config

Owns settings.json read/merge/atomic replacement and polling. See
[configuration](../../docs/architecture/configuration.md).

- `provider.ts` supplies one native ConfigProvider, immutable snapshots and
  ConfigFile writes. No environment fallback or KeyValueStore path. Explicitly
  injected native providers are read-only; they never write an unrelated file.
- Domains own one Effect Schema and its defaults. `router.ts` is the static
  inventory of public domains; native Config.schema reuses those declarations.
- Parse at boundaries. Merge-patch null deletes keys; persisted null is invalid.
  Patch schemas omit defaults and object-wide checks; validate merged domains
  before saving. Unknown file namespaces survive and remain private.
- Serialize poll/read/merge/write. A write uses a sibling temporary file and
  rename; committed snapshot publication survives caller cancellation. Never
  update memory before the file. External writers remain last-replacement-wins.
- Startup read/JSON errors fail construction. Reload errors invalidate reads
  and publish config.changed; corrected content recovers. Scope stops polling.
- Config events contain no values or secrets. Native updates belong only to
  their source. Domains own applying configuration and resource replacement;
  this module does not create providers or manage their lifetimes.
