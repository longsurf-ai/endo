# agent-schedule

Owns user-authored definitions, prompt targets, recurrence, and managed cursors;
Scheduler owns timing/admission.

- schema.ts owns tables and canonical target/recurrence schemas; entity derives
  from them. No user ownership. Targets are a shared AgentPromptTarget (opaque
  binding keys); new target kinds extend the union and Scheduler dispatch.
- Store calculates the first future cursor on client create, recurrence change,
  and re-enable. Rename, target edits, and pause preserve it. Internal writes
  may supply it. No remaining fire fails without committing writes/events.
- advanceSchedule is a backend declaration, not a client mutation. Through
  Transactor, update only when selected revision/cursor still match; preserve
  missing, edited, or paused definitions. Compute the next future cron instant.
- Effect owns the clock. Cron calculation/validation creates paused instances
  only; Resource CRUD starts no timers or target execution.
- Strict recurrence parsing accepts supported five-field cron and valid zones;
  once requires canonical UTC. Unknown fields fail.
- Delete physically and cascade Occurrences; preserve Runs, Sessions, and transcripts.
  No soft-delete state or embedded occurrence history. Occurrences own independent
  envelopes/revisions and one acceptance per fire instant.
- Schema loading remains independent of Scheduler, models, Stores, and runtime.
  Framework owns revisions, pagination, and change detection.
