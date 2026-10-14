# agent-schedule-occurrence

Owns durable acceptance provenance with a complete backend Store and intrinsic read-only API.

- All domain fields are server-managed; scheduleId is a list key. readOnly hides
  intrinsic mutations; get/list and ensureOccurrence remain public. Derive entity/Store types from
  owned schemas; empty writable bodies accept no partial provenance.
- Schedule/Run FKs preserve identity; script collections record no Run, and no
  Session. Deleting Schedule cascades Occurrences;
  deleting Occurrence never deletes Run/Session. Referenced Run deletion is restricted.
- sessionId derives from Run through a join, never a duplicate column.
  Explicit backend sessionId must match that Run or roll back.
- scheduleId/fireAt and agentRunId are independently unique. fireAt is planned time;
  envelope createdAt records acceptance, with no second acceptance timestamp.
- Intrinsic create/ensureOccurrence use Transactor, assign ID/revision, and decode
  complete stored entities before commit. Shared Database invalidation follows commit.
- List filters/windows the joined SQL query before returning a page.
- [ensureOccurrence](transitions/AGENTS.md) searches the full paginated schedule
  history before insertion in one transaction. Replay must match Run and Session.
  Scheduler invokes it after admission; this Resource creates no Run or timer.
- Run owns execution status/results; Schedule never embeds unbounded history.
