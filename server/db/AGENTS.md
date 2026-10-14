# db

Owns application SQLite, schema assembly, and forward-only migrations.

- Database.Service is the only application connection. Stores use it or caller Tx;
  Resource/Agent/Credential tables stay with their owners. `drizzle.config.ts`
  discovers their union.
- `event-detector.ts` discovers complete Resource envelopes after migration.
  Temporary triggers capture actual root changes, including cascades. Internal
  and Agent tables have no envelope; root writes require db.transaction.
- Nested transactions are savepoints. Only successful outer commits deliver;
  rollback/defects/interruption discard changes. Coalesce by table/id with last
  revision; deletion retains OLD.revision.
- Transactions/callbacks serialize. Deliver injected onCommitted after commit,
  without interruption; it cannot open another transaction on this connection.
  Database imports no Events/Resource protocols. Migration startup emits no events.
- `just migration <name>` generates schema.json, schema.gen.ts, and migration.gen.ts;
  db:check rejects drift. Never edit applied migrations; append forward changes.
- Ledger IDs, filenames, and checksums exactly match a registry prefix. Runner
  owns transactions; up uses its supplied Tx. Fresh databases load the schema
  and mark history complete; nonempty databases without a ledger fail.
- Test only with memory/temporary databases. See [migration](migration/AGENTS.md)
  and [test](test/AGENTS.md) instructions.
