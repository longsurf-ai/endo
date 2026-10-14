# utils

`@openchart/utils` owns the lowest-level shared assertion, error, lazy-value,
and function helpers for OpenChart. Import helpers through `@openchart/utils/<name>`.

## Invariants

- Utilities never depend on models, app, server, platform, V1, or Effect.
- Preserve the existing helpers' behavior, especially immediate invariant
  failures.
- Domain and provider policy belong to their owning packages, not here.
