# profiles

Owns resolved profiles and scoped registration. See
[Agent architecture](../../../docs/architecture/agent.md).

- `profile.ts` owns Info and Service; RequestAgent derives from Info. Import
  permission rules from pure types, never the Permission service. Model preferences
  reuse AgentPromptModel provider/tier fields.
- Published profiles satisfy Info; names/prompts are nonblank and prompt text
  is preserved. Mutable drafts exist only during rebuild.
- `resolve/all` never substitutes another profile for an explicit missing name.
  Defaults exclude hidden/subagent profiles and follow configured selection,
  analyst, then catalog order.
- `state.ts` replays scoped transforms over a fresh Map in registration order.
  Publish fully validated candidates; remove failed registrations and withdraw
  contributions on disposal. Public values stay read-only.
- Inject configuration; do not load files or Config.Service. Merge options by
  key; permission precedence is built-in, global, then profile configuration.
- `builtin.ts` alone registers analyst/title/compaction. Compile owned manifests/assets;
  Resource guidance stays generic and catalog-derived; domain guidance uses named segments.
  Analyst allows every built-in tool (`../tool/registry.ts`), so OpenChart tools
  need no approval by default; title/compaction deny tools.
- Construction performs no discovery or execution. Prompt owns model/variant
  resolution and invocation snapshots.
- Profiles contain no executable plugins. Catalog selection remains independent;
  active invocations retain captured profiles on reload.
