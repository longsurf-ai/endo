# resource

Transport-independent; no business nouns or request Context. See
[Resource contract](../../../docs/architecture/resource.md).

- Complete entity schemas own IDs, serverManaged/listKey annotations, invariants,
  and derived read/write/filter shapes. Reject unknown fields everywhere.
  Writable updates validate complete values.
- Transitions own IDs, revisions, existence checks, patching, and decoding;
  Stores own SQL/table mapping through caller transactions. Internal managed
  writes obey storage invariants.
- **Do not add Store primitives when existing ones suffice.** Prefer listing
  then filtering in memory over new Store methods/query syntax when simpler.
- Construction performs no I/O. Transactor runs resolve, then one
  transaction/apply. External facts resolve first; consistent reads use Tx.
  Compose phases without nested run calls. Custom actions use their own Store;
  cross-Resource macros compose public transitions.
- Patch cloned writable data sequentially; validate before saving.
  Check expectedRevision within Tx. Decode complete stored entities
  before commit; invalid persisted state defects roll back everything.
- Lists sort by `createdAt` (default) or `updatedAt`, then ID, before pagination;
  `order: "desc"` reverses the default ascending order. Decode opaque cursors once;
  keep the same filter/order while paging. listAll retains creation order.
- Database detects committed root changes; events maps/publishes them. Stores/Transactor
  never publish. Child writes advance root revision atomically;
  deletions invalidate even at unchanged revision.
- Adapters derive APIs from definitions and honor readOnly. Generic Agent writes remain intrinsic; dedicated tools may call custom transitions.
