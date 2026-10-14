# plugin

Owns trusted hooks, ordered catalog, and invocation-scoped execution. See
[plugin architecture](../../../docs/architecture/agent-plugins.md).

- `plugin.ts` is the public boundary; `contract.ts` alone defines hooks.
  Shared Agent schemas own input/context data. No second runtime or durable ledger.
- Registry copies/freezes definitions, selects exact agent names in order, and
  validates selected input ownership before materialization. Profile is independent.
- Each trigger input type has one preparation owner, which enforces cardinality
  and authority and must implement `run.before`.
- Prompt commits the trigger User, creates a fresh Plugin.Service, and provides
  it through the invocation. Each child creates its own instance. Scope owns
  setup/cleanup across success, failure, and interruption.
- Detach/freeze invocation identity and inputs before setup. `bind` captures
  application dependencies but uses invocation Scope; dependencies must outlive it.
- Hooks run in catalog order with detached inputs/outputs. Expected failures
  retain attribution; defects/interruption propagate. Preparation failure prevents model I/O.
- `run.before` runs once before title/model work and returns PluginContext[].
  Prompt assigns Part identities and commits through generic Session.createParts.
  Plugins never write transcripts; plugin/hook pairs may repeat without reconciliation
  or an authorship guarantee.
- Workflow definitions own arguments/execution. Concrete business logic stays with
  feature owners; Processor and step snapshots contain no plugin state.
