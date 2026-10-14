# identifier

Owns `@openchart/identifier`: shared identifier schemas and suffix generation.

## Invariants

- `defineId` owns prefix validation, branding, and the `.create()` constructor.
  Domains declare their own prefixes and brands; this package names no domain.
- Generated suffixes contain eight Base62 timestamp/counter characters and six
  random Base62 characters. Ascending is the default; owners may select descending.
- Generation remains monotonic within one module instance when the wall clock
  moves backward or more than fifteen IDs are requested in one millisecond.
  Separate processes use independent counters and probabilistic uniqueness.
- Randomness uses Web Crypto. The package imports no Node, server, app, platform,
  database, or Effect service. Schema declaration generates no ID.
- Callers own when IDs are created. Moving generation into common does not grant
  clients permission to choose fields managed by server operations.
