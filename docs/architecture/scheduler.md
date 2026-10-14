# Scheduler

The `create_schedule` Agent tool creates an enabled recurring schedule from a
name, prompt text, and the existing cron recurrence schema. It inherits the
current invocation's agent, model, and workspace through `Workflow.Service` and
calls `agentScheduleResource.transitions.create` through `Transactor` after the
usual tool permission check. Schedule remains the owner of validation and the
next-fire cursor. Each fire creates a fresh Session; the tool copies no history
or binding and performs no immediate dispatch. Analyst guidance uses this tool
directly without Resource schema discovery; other schedule edits use the
existing Resource tools.

`server/scheduler/` owns scheduled dispatch across server domains. Its public
contract is `Scheduler.Service` from `@openchart/server/scheduler`: `runLoop()` owns
timed scanning and `runNow(id)` admits one immediate fire. Signatures derive from
the implementations, including service requirements; `Effect.forever` gives
`runLoop()` a success type of `never`.

```ts
import { Effect } from "effect";
import { Scheduler } from "@openchart/server/scheduler";

const program = Effect.gen(function* () {
  const scheduler = yield* Scheduler.Service;
  yield* scheduler.runLoop();
});
```

`Scheduler.layer` registers the operations without acquiring dependencies or
starting work. The inferred requirements flow through the background Layer to
application composition; no manual context capture or provisioning is needed.
`scheduler/background.ts` forks one `runLoop()` using `Layer.effectDiscard` and
`Effect.forkScoped`; `runtime.ts` composes these Layers. Request
completion does not stop the fiber. Runtime disposal awaits its interruption
cleanup before releasing dependencies. There are no separate start/stop controls.
`await createServer()` initializes the runtime before returning an unbound Node
server; the HTTP-only demo likewise awaits `runtime.context()` before listening.
Failed initialization is disposed before the failure propagates.

The loop scans immediately and sleeps thirty seconds after each completed scan.
`Effect.forever` and `Effect.sleep` preserve sequential execution and interruptible,
testable timing without timer handles or a separate lifecycle state machine.
Each scan fixes a clock cutoff and reads Schedule through intrinsic `listAll` in
one Transactor transaction. Scheduler filters enabled, due definitions in memory.
For each one-time candidate, it uses Occurrence `listAll` by `scheduleId` and skips
the fire only when an occurrence has the same `fireAt`. The shared intrinsic
operation owns bounded pagination and collects the complete arrays before business
filtering; both reads use the scan's transaction.
The eligible definitions are sorted by `(nextFireAt, id)` in memory, then admitted
sequentially after the read transaction closes. The local app accepts these extra
reads and the in-memory result set to avoid dedicated query transitions, SQL, and
a second pagination protocol. Per-fire failures are logged and skipped for that
scan, so an old failing definition cannot starve later rows. A failed query
retries on the next scan. Unexpected defects
and interruption propagate; normal shutdown is not logged as an error.

The `scheduler.runNow` mutation reads the latest definition and uses the server
clock as its fire instant. It shares Session resolution, prompt admission and
Occurrence recording with timed dispatch, returning the Occurrence after
acceptance without waiting for execution. It works while disabled and never
changes `enabled`, recurrence, revision or `nextFireAt`. A manual run before a
future one-time fire does not consume that planned fire. At an identical fire
instant, manual and timed admission share the existing intent and Occurrence.
Only the timed loop advances the cursor. Admission/bookkeeping failures surface
to the caller; the UI does not automatically retry a manual request. The UI
refreshes history and opens the accepted Session on success.

Dispatch performs these operations in order; steps 1 and 2 are the shared
`admitPromptTarget` beside `submitPrompt`, which Trigger dispatch also uses:

1. Look up `schedule:<scheduleId>:<fireAt>` through `AgentRunStore.getByIntent`.
   Reuse an accepted Run's Session and immutable input. Otherwise create an
   unbound Session, or resolve the target's opaque binding key through
   `Session.getOrCreateBound`. Agent owns current-session selection in binding
   history, ordered by `createdAt DESC, id DESC`.
2. Call `submitPrompt` with that intent and request. It admits or replays the Run,
   wakes Session execution, and returns without waiting for the model.
3. Run the Occurrence owner's `ensureOccurrence` transition. Its transaction
   lists Occurrences by scheduleId and finds fireAt in memory, following the
   shared pagination cursor. It returns matching provenance or inserts after
   exhausting the list, in the same transaction. Run supplies the projected Session ID.
4. Run the Schedule owner's `advanceSchedule` transition. Cron advances to its
   first future instant using the authored time zone. The transaction compares
   the selected revision and cursor before saving and incrementing the revision.
   A one-time fire retains its cursor and enabled flag; its occurrence exhausts it.

These are retryable individual operations, not one cross-domain transaction.
Existing Session commit/publication, Run enqueue/wake, Resource Transactor,
database change delivery, and uniqueness/FK guarantees are unchanged. Existing
schemas already represent all required facts; no migration is needed.

A failure before admission can leave an empty Session. A failure after admission
reuses the accepted Run, Session, and input on retry, even if the target or binding
changed. Occurrence failure leaves the cursor due; cursor failure leaves the
occurrence committed and safe to replay. Cursor advancement never overwrites an
intervening edit, pause, or deletion. An already selected fire may still be admitted
while those changes race it; deletion or recurrence edits can prevent later repair
of incomplete bookkeeping. This is the intended best-effort contract.

Run execution, terminal status, and crash recovery remain Agent responsibilities.
Retrying a queued admission can repair a missed wake, but the scheduler does not
reset or restart a Run that Agent already marked running or terminal. Scheduling
other target kinds can extend dispatch while retaining target-owned admission APIs.
