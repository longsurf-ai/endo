# llm

Owns one lazy, scoped request through `LLM.Service.stream`. Test through that
public API; keep helpers private.

- Require a resolved model; validate its variant once. Callers own selection.
  Metadata contains no request options.
- Scope owns request/callback cleanup. Abort before awaiting iterator return,
  including an interrupted in-flight pull; registry lifetime stays with Models.
- SDK/MCP callbacks are the Effect-to-Promise boundary. Preserve required services;
  expected failures/interruption reject SDK callbacks, while defects also fail
  the outer stream. Closed requests cannot start callbacks.
- Preflight validates encoded tool input without transforming it. Tool owners
  decode once before execution. Repair only names/deterministic JSON encoding;
  semantic mistakes remain tool errors.
- Local tools execute one SDK step; Prompt owns continuation. Provider-managed
  observations never execute tools again: adapters run host tools in-process and
  emit exact outcomes. Delegate conformance runs after streamText; common/models owns it.
- Commit request snapshots before model I/O; persistence errors keep their types.
  Provider failures become RequestFailed; defects/interruption remain distinct.
- Preserve API and provider-managed paths. Caller owns policy, persistence,
  sampling, headers, and explicit options; synthesize no caching/storage defaults.
- `tool-call.ts` emits ordinary deterministic events through the same Processor;
  selection and authorization stay with Prompt. No Session/Run creation here.
