# agent

Owns durable admission and process-local orchestration. See
[Agent architecture](../../docs/architecture/agent.md).

<!-- HUMAN-ANNOTATION:START -->

`prompt` is the single global entry point for all agent interactions. We should never
create any other entrypoint for agent interaction. Violating this is a NO-GO and
shall be flagged immediately.

<!-- HUMAN-ANNOTATION:END -->

- `submitPrompt` persists or replays accepted input, then wakes SessionExecution.
  `agent_run` is the only durable queue. Runs require an existing Session;
  admission never creates one. Immutable intent identifies retries.
- SessionExecution serializes each Session; different Sessions may run concurrently.
  Runner owns atomic claim and terminal writes. Expected prompt failures allow
  queue progress; defects, interruption, and storage failures stop the drain.
- `recovery.ts` owns startup repair and queue wake: Session repairs transcripts,
  then `recoverQueue` calls RunStore.fail with normal publication before waking
  queued Sessions. Failure aborts startup; retry preserves committed repairs.
  Never replay interrupted work.
- `Prompt → Processor → LLM → Models/SDK`: Prompt chooses inputs/history and
  continuation; Processor commits transcript facts and completes cleanup before
  returning; LLM owns one scoped request. Do not duplicate their state machines.
- `contracts/` owns shared contracts; `schema.ts` owns runtime tables without
  Resource envelopes. Schedule/Occurrence belong in `resources`.
- Session owns data operations; Stores own SQL. Writes publish committed facts
  through Publisher under the Events barrier. Domain code imports neither AG-UI
  nor its adapter. Events provide live notification, not durable replay.
- Application runtime shares Profiles, ToolRegistry, Permission, and Models.
  Prompt creates fresh Plugin/Workflow services per invocation.
- Workflow children use fresh Sessions and the same prompt engine/root Run;
  they create no Runs or copied history.
- Provider-native skills stay with model adapters; Agent stores no authored skills.
