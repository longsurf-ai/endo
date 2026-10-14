# tool

Owns Effect tool definitions, initialization, registry, and parameter decoding.

<!-- HUMAN-ANNOTATION:START -->

`metadata` must never carry business inputs into execution. It only reports status
and execution snapshots, which may include parameter snapshots. Business inputs
must be passed through explicit call arguments.

<!-- HUMAN-ANNOTATION:END -->

- `tool.ts` owns initialization and parameter decoding. Setup
  never captures invocation context; host owns resources and Scope.
  Preserve outcomes, interruption and permissions; no separate runtime/retries.
- Context requires root Run, Session, Message and call identity. Processor
  commits the ToolPart first and owns progress/terminal writes; native Promises
  receive cancellation. Child Assistants retain their actual provider/Session.
- `registry.ts` owns discovery without execution. Resource
  tools derive schemas from the catalog, honor readOnly, expose intrinsic writes
  only, and check permissions even for schema-only reads. Dedicated tools may
  call Resource transitions; `create_schedule` creates an Agent Schedule.
- Tools return output/evidence/attachment contracts. Message/Processor
  owners materialize evidence; tools never write transcript state.
- Resource errors become diagnostics after transaction cleanup. Never retry writes
  automatically or swallow cancellation/Permission outcomes.
- Transcript reads preserve Parts/cursors, enforce
  snapshot cutoffs, and share `message/transcript-text.ts` projection. Search
  excludes the caller's Session and bounds snippets; unknown cursors fail.
