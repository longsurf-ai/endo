# Desktop

Owns Electron startup, backend, storage, packaging and the
[changelog](src/changelog/AGENTS.md). See [architecture](../../docs/architecture/desktop.md).

- Main owns windows, the run token and host capabilities (notifications, folder
  picker, opening/revealing paths), no business logic; backend-entry sets network
  defaults, then starts the server. Preload exposes exactly those operations.
- Parse all four host-protocol messages. Secrets stay in messages, never argv/URLs/logs.
  Readiness expires after 30 seconds. Quit/repeated Quit await backend cleanup
  and exit. Pre-ready failures log/exit in development; release dialogs await ready.
- Open windows after backend readiness. IPC accepts only the renderer's main
  frame. Preserve sandboxing, context isolation, disabled Node integration,
  denied device permissions/new windows, navigation restrictions and CSP.
- `reagent://app` serves bundled pages; its scheme is registered privileged
  before ready. Config owns settings; Home owns paths (`~/.reagent`,
  `~/.reagent-dev`, or `--reagent-home`). Assets stay inside bundles; missing
  files/APIs never become HTML. Only development accepts loopback URLs.
- Development/release share ASAR layout and packaged dependencies. Dev profile
  persists under `.artifacts/dev-profile`; dev/smoke use mock Keychain.
- Packaging is ad-hoc signed unless `REAGENT_SIGNING_IDENTITY` (and optionally
  `REAGENT_NOTARY_PROFILE`) is set. There is no auto-updater.
