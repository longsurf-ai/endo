# Workspace transitions

Owns directory preparation, registration, and forget. SQL stays in the Resource Store.

- `register` resolves the existing canonical directory before the transaction.
  Apply assigns an ID and revision 1, inserts through the Store's overlap checks,
  and decodes the complete entity before commit.
- `forget` resolves the Home default path, then checks existence and default
  protection in the caller's transaction. It never removes filesystem content.
- `createLocal` prepares an unnamed Home directory in resolve and reuses register.
  Internal `ensureDefault` prepares the default directory, then finds or registers
  its row in one apply. Startup owns Transactor.run; directory preparation is not rolled back.
- Declarations own input schemas. Construction performs no I/O; apply uses the
  supplied transaction and never opens a transaction or publishes events.
- `getDefault` is a query: it reads the default ID from registry pages in one
  transaction, without creating rows or restoring directories.
- The Resource router exposes getDefault/register/forget/createLocal automatically;
  ensureDefault stays internal. readOnly hides intrinsic mutations.
  Agent tools cannot invoke custom transitions.
