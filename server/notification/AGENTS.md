# notification

Owns the server side of the host notification capability. See
[desktop architecture](../../docs/architecture/desktop.md).

- Stateless: no Resource, table, queue, history, retry or acknowledgement.
- `RuntimeOptions.notify` is host-supplied, like `credentialEncryption`;
  `runtime.ts` passes it to `Notification.layer`. The server never imports a
  platform to display anything.
- `notify` never fails its caller. A throwing host is logged; a host without
  the capability (demo, tests) logs at debug level and succeeds.
- Callers supply `{title, body, sound?}` with an optional catalog sound override;
  omission reads `notifications.sound` from current Config. Send only the
  title, body and resolved sound ID to the host. No mirrored
  preference state, templating, deduplication or throttling. Config failures log
  and skip delivery, never silently substitute another sound.
- The host only displays. It holds no business logic and never subscribes to
  the backend; see [desktop](../../docs/architecture/desktop.md).
