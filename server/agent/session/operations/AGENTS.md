# operations

Owns Session, Message, and Part actions. `session.ts` registers functions directly.

- Choose defaults and IDs here; Stores own SQL. Use `commit.ts` outside existing
  transactions; publish committed facts. Preserve inferred Effect requirements.
- `update` owns committed metadata publication for manual and automatic titles.
  Preserve identity and creation time.
- `fork` atomically copies settled history through an Assistant into an unbound
  root with fresh IDs. Copy no execution, bindings, or approvals; preserve source.
- `truncate` changes only idle chats: retain the selected Assistant (null
  clears history), cascade trailing Parts, remove their anchors, then publish.
  Preserve Runs/children; only a separate `submitPrompt` starts new work.
- `digIn` commits a fresh child, copied history, and parent anchor together; no
  creation replay. Both branches reject Dig In sources/copied markers via `internal/branch.ts`.
- `readTranscriptPage` is the sole display-history reader, returning visible
  complete turns. `readSnapshot` adds Run/Permission views to its latest page.
  Callers hold Events' barrier, never Permission's mutation lock. Raw model and
  branch history stays with Message Store, separate from display pages.
- Message creation touches its Session atomically and publishes both facts;
  Part streaming leaves Session unchanged.
- `createParts` commits its batch before publishing in order.
  `finishStep` commits Assistant and marker together. Adapters own wire projection.
- `interruptUnfinished` owns Clock and a startup-only transaction without live
  publication. Failure rolls back; retries preserve completed content and errors.
