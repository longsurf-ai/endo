# parts

Owns concrete Part schemas and nested content; `part.ts` owns the public union.

- Each `*-part.ts` owns one variant. PartBase has `id` and `messageID`; no
  `sessionID` or origin flag. External consumers import `@openchart/server/agent/contracts/part`.
- Import only Effect schema primitives, shared base, and required sibling Parts;
  never aggregate Part, Message, anchor, or prompt input contracts. Tests may
  use aggregates to verify composition.
- Text uses `synthetic` for model-only content; metadata does not control visibility.
- Tool `providerMetadata` serves replay; `state.metadata` serves execution.
  Complete input comes from tool calls, not persisted raw fragments. Preserve
  unique `childSessionIds` across terminal states. Links describe direct child
  Sessions, not their calls or lifecycle. No displayData or per-tool card schemas.
- Context has one durable payload. Quote stores only text; dig-in selection lives
  in Session anchors. They remain distinct kinds. Resource definitions own resolution;
  this package owns no resource-kind whitelist.
- Plugin context records `pluginId`, `hook`, and `content`. Part ID owns identity;
  plugin/hook pairs may repeat and establish no trusted authorship.
- `plugin-input-part.ts` owns PluginInput: a JSON object tagged by `type`. The
  owning plugin decodes its fields; no feature variants are registered.
- WorkflowPart is immutable intent. Assistant lifecycle determines execution
  progress; do not add Part consumption state.
- Document evidence remains immutable input; the server evidence owner
  materializes bounded blocks before replay.
