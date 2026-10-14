# workspace

Owns the SQLite registry of immutable canonical directories. Files, indexes,
watchers, and file mutations belong to `server/workspace`.

- readOnly hides intrinsic create/patch/delete. Resource APIs expose get/list and
  the `getDefault` query and `register`/`forget`/`createLocal` mutations;
  Agent tools expose only intrinsic reads.
- Registration resolves the existing canonical directory before the transaction;
  insertion rejects duplicate and ancestor/descendant roots in that transaction.
- root is required at registration and cannot change through internal save.
  Forget deletes only the registration. The default root under Home is protected.
- IDs are ordinary generated WorkspaceIds. No marker files, content copies,
  hidden metadata, or second persisted registry.
- `transitions/ensure-default.ts` owns default directory preparation and the
  internal startup transition; `create-local.ts` prepares unnamed Home directories.
  Both reuse register. External disappearance of another registered directory
  does not remove its record.
