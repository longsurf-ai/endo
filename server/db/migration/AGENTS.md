# migration

Contains the generated, forward-only TypeScript migrations for the complete
application schema.

## Invariants

- Filenames and exported ids use `<YYYYMMDDHHMMSS>_<name>` and sort in execution
  order.
- Existing files are immutable because their exact SHA-256 values are persisted
  in `app_schema_migrations`.
- Each migration exports one `DatabaseMigration.Migration`; it never opens a
  database or starts its own transaction.
- Migrations never import current schemas; they freeze the shapes they read and
  write. A data-only change, such as a new JSON column shape, has no DDL diff,
  so `just migration` writes no file: add `<timestamp>_<name>.ts` by hand, then
  rerun it to register the checksum.
