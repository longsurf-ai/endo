# workflow

Owns authoring, loading, execution, and child Sessions. See
[architecture](../../../docs/architecture/workflow.md).

- Programs import only `@openchart/workflow`, bound to the host SDK.
  `workspace:` selects prompt workspace; `default:` selects default.
  Load fresh `.workflow.ts`; persist source workspace/path/hash; preserve child cwd.
  `templates/` seeds missing `workflows/` at startup; disk edits win.
  Type-check and emit one snapshot against bundled SDK declarations before
  evaluation; diagnostics use LoadFailed. Trusted programs aren't sandboxed.
- WorkflowPart owns intent. Deterministic/model calls share WorkflowTool and
  Processor. Accepted intent authorizes only its concrete call; children retain
  normal permissions. No consumption marker or durable DAG lifecycle.
- Host creates fresh persisted Sessions without copied history or child Runs.
  Continuations target only its children. Per-Session semaphores cover execution,
  cleanup, and answer reads. Capture real LLM before deterministic overrides.
- Persist immutable preparedArgs before execution and retain terminal metadata.
  Register childSessionIds before execution; continuations reuse the link.
- Each run bounds agent calls with its own semaphore. Parallel preserves order,
  isolates expected failures, and propagates defects/interruption. Cancellation
  joins cleanup and never starts queued children.
- Authoring owns spans; tracing bridges Effect/OTel. Calls have distinct span IDs;
  Sessions group turns. Live spans have zero end timestamps; completed snapshots
  are standard OTLP. Await metadata publication, including cancellation.
