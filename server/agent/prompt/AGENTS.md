# prompt

Owns invocation execution. See [architecture](../../../docs/architecture/agent.md).

- `execute` handles claimed Runs; Runner owns admission, exclusivity and terminal
  transitions. Expected errors become Failed; defects/interruption retain causes.
- Scope owns title, Plugin/Workflow, requests and cleanup; Models owns providers.
- Validate before atomic User/input/evidence commits. Preserve IDs; unsupported
  inputs fail before writes. Input forbids Dig In markers; child User inherits
  its parent anchor.
- Capture profile, resolved model and plugins once. After User commit, run
  preparation hooks once and commit contexts before title/model I/O.
- Pass accepted root Run through preparation/steps to Tool.Context; child
  Assistants retain their own author/provider and Session.
- Reread committed history in storage order each iteration. Natural completion
  belongs to latest User; IDs never determine order.
- Select at most one deterministic action after last completed Assistant, finish
  writes before rereading, and reject competing executable Parts. Workflow intent
  precedes automatic compaction.
- `step.ts` shares Assistant creation, tool binding and Processor processing.
  Processor owns persistence, barriers and cleanup.
- Accepted deterministic calls have a step-local approval bypass; later/child calls
  use normal policy. Native approvals use `agent: null`.
- Seal compaction only after successful visible summaries; never delete history.
  Unknown capacity disables automatic compaction. Titles preserve user edits.
