# providers

One folder per native CLI provider, plus flat helpers only providers use.
`index.ts` is the only module that names more than one. Root `common/models`
modules never import from here; they take a `NativeProvider` (see
`native-provider.ts` in the parent) as a parameter.

- `<id>/adapter/`: the independent AI SDK adapter. Imports only
  `@openchart/models/provider-protocol`, `continuation.ts`, `generate.ts` and
  utils; never the binding, tiers, or sibling adapters (architecture test).
- `continuation.ts` and `generate.ts` are shared by all adapters: append-only
  prompts reuse the native conversation; buffered generation replays one stream.
- `model-catalog.ts`: catalog enrichment shared by all bindings.
- `<id>/binding.ts`: OpenChart product policy for that provider, exported as
  one `NativeProvider` object: discovery, catalog enrichment, quota
  translation, permission mapping, request options, native message rules.
- `<id>/tiers.ts`: the tier table. The usual edit when a model ships.
- `executable.ts`: checks the host-supplied executable path; never searches PATH.
- `provider-permission.live.test.ts`: opt-in run against logged-in CLIs.
