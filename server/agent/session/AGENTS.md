# session

Owns Session data, admission, and coordination.
[message](message/AGENTS.md) owns transcript storage/projection.
[operations](operations/AGENTS.md) owns Session, Message, and Part data actions.

- `Session.Service` only registers operations; preserve inferred requirements.
- Stores own SQL in caller transactions; never commit, enqueue, publish, or generate IDs.
- `commit.ts` owns outer writes and post-commit publication under Events.withBarrier.
  Write outside existing transactions. Failures publish nothing; committed publication is uninterruptible.
- Bindings use opaque unique keys. Current/history order is
  `createdAt DESC, id DESC`; attachment never promotes older Sessions. Deletion
  cannot resurrect bindings. Cursors preserve filters and survive deletion.
- Directory: unarchived root `chat`, descending `updatedAt` (default)
  or `createdAt`, then ID. Cursors bind order/filters; bindings retain creation order.
- Archive changes metadata only; preserve history, bindings, and execution.
- Read marks derive Session ownership from ended Runs. `lastReadRunId` only advances;
  preserve `updatedAt`. Metadata cannot change it; newer ended Runs imply unread.
- `submitPrompt` enqueues/replays then wakes execution without awaiting completion.
  Coordinator owns scoped drain fibers.
  Scheduler/Trigger share `admitPromptTarget`, resolving stored targets' Sessions first.
- Runner protects claim/terminal writes while Prompt remains interruptible.
  Pure interruption writes `stop`; execution or cleanup errors write `failed`.
  Expected failures permit queue progress; defects/interruption/storage failures
  stop it. Inner execution owns transcript cleanup.
