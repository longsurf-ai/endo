# Occurrence transitions

Owns custom Occurrence operations. SQL remains in the Resource's `store.ts`.

## Invariants

- `ensureOccurrence` lists its own Store by scheduleId, follows the shared
  nextCursor, and finds the exact fireAt in memory. It inserts only after all
  pages are exhausted. Lookup and insert use the same transaction, with no
  dedicated lookup SQL. It assigns an ID and revision 1 only when absent and decodes
  the complete entity before commit. Replays retain the accepted Run and projected
  Session.
- Apply uses the supplied transaction. Transitions never open transactions or
  publish invalidations; they reuse shared Resource validation and write rules.
