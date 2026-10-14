# Workspace files

`resources/workspace` owns registrations; disk owns artifacts. Workspace owns
scoped observations and file APIs.

- Parse paths at transport boundaries; reject symlinks and hidden segments.
- Default originals, and folders holding them, reject mutations
  case-insensitively; originals read `readOnly`; `installBuiltin` restores them.
- Root is immutable; operations require registration. Forget closes admission
  and subscriptions, drains mutations and releases watchers; never deletes files.
- Effect owns scopes, queues, retries and caches; Chokidar owns watching.
  RcMap shares shallow directory watchers by active consumer; no eager root watch.
  Listings read metadata only; never cache text.
- Index non-hidden directories, even empty ones, and files of any type.
  `mkdir` keeps existing folders; `rename` moves files and folders without
  overwriting.
- Reads return Base64, hash and MIME: media by extension, else `text/plain`
  for UTF-8 without NUL. Reads cap at 32 MiB, even under growth; scans skip more.
- Text writes reject media paths and binary content. Reads install no
  support files; Workflow owns execution.
- Hash exact bytes on reads/CAS. Serialize writes, never listings; external
  editors share no lock. Committed writes need no scan. Missing ≠ unavailable.
- Errors stay in errors.ts; structured conflicts use the shared boundary.
  Watcher events invalidate, never transact.
