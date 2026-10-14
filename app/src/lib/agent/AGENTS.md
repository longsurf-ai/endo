# Shared Agent

- `use-agent.ts`: one client, Query mutations and SessionStore per transport.
  AppLayout owns lifetime; `provider.tsx` adds no state/observers. Features never import each other.
- `client.ts` parses native AG-UI events and adapts existing backend commands.
  Subscribe before snapshots; reconnect reads authoritative history.
- `queries.ts` owns finite reads and invalidation. Directory reads never observe
  transcripts. Sorting switches queries without recreating SessionStore.
  `model-selection.ts` resolves models; `native-provider-brands.tsx` names providers.
- `session-store.ts` shares one AG-UI observer and Query infinite-page observer per
  Session ID. `transcript.ts` merges pages/live content by ID; snapshots cancel/reset
  pages even with unchanged cursors. AG-UI owns reduction;
  never add a transcript reducer, execution state machine or replay buffer.
  Last detach stops observation, never execution. Disposal releases observers;
  retain handles for effect reactivation.
- `use-session-snapshot.ts` adapts session handles to React;
  `session-progress.ts` derives active Run progress without storing it.
  `use-bound-session.ts` observes a binding's Session and workflow span.
  Mounting never creates or submits a Session.
- `use-session-read.ts` acknowledges displayed ended Runs when visible/focused.
  Persisted watermarks confirm reads; Session updates refresh the directory. No local read store.
- Submit only through the existing Session prompt command. Hosts own navigation;
  features own prompts/presentation. Chat UI and assistant-ui adapters stay in
  `features/agent`. Tests belong in `__tests__/`.
