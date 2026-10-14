# db tests

Owns tests for the application database, migration history, schema generator,
and committed-change detection.

## Invariants

- Database tests live here so `db/` keeps its implementation and generated artifacts.
- Tests use `:memory:` or temporary files, never a developer's application database.
- Generator tests copy the server layout into a temporary directory before writing artifacts.
- Migration tests build historical rows from literals, never by decoding with
  current schemas. When a later migration reshapes those rows, an older test
  stops at its own migration (`migrations.slice(0, at + 1)`) instead of
  expecting the new shape.
