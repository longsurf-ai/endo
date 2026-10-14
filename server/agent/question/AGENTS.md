# question

Owns process-local native clarification waits, answers, and pending state.

- Prompt binds `ask` to its Session. Replies settle an existing callback; they
  never create a User message, Run, or new prompt interaction.
- Adapters parse native payloads. Reply schemas decode HTTP input; this owner
  validates answer IDs, cardinality, choices, and nonempty text against the request.
- Waiting holds no lock or transaction. Writes hold the mutation lock before
  the Events barrier; snapshot reads never acquire that lock.
- Requests remain owned by their Session and visible to delegate ancestors.
  Session snapshots and Publisher updates use the same `list` projection.
- Skip is explicit and settles one request. Interruption removes it; disposal
  interrupts all waits. Stale replies fail. No rules or permission grants apply.
- Answers belong in the provider tool transcript; pending state is not persisted.
