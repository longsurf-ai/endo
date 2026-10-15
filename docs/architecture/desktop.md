# Desktop

`platform/desktop` is the only application host. It starts Electron, runs the
whole server in an Electron utility process, opens windows on the shared app,
and packages both into one bundle. The shared app never imports Electron; it
receives native operations through `AppHost` (see `app/src/lib/host/host.ts`).

## Development

```sh
just install --frozen-lockfile
just desktop
```

`just desktop` builds `main`, `backend` and `preload`, starts Vite for the
renderer on `127.0.0.1:43875`, packages an ad-hoc signed
`Endo Development.app` under `platform/desktop/.artifacts/dev`, and launches
it with:

- `--user-data-dir=platform/desktop/.artifacts/dev-profile` (browser storage),
- `--endo-home=platform/desktop/.artifacts/dev-profile/home` (SQLite,
  settings, model runtimes, workspaces),
- `--use-mock-keychain` on macOS,
- `ENDO_DESKTOP_DEV_URL` pointing at Vite, so the renderer hot-reloads.

Main, backend and preload do not hot-reload; restart `just desktop` after
changing them. Each checkout keeps its own development profile.

## Process model

```text
Electron main (dist/main/main.js)
  ├─ utilityProcess -> backend (dist/main/backend.js)
  │     createServer(): SQLite, tRPC + SSE on 127.0.0.1:<port>
  │     parentPort: init {token, home, rendererOrigin}
  │                 -> ready {port} ... notify {title, body, sound} ... shutdown -> exit 0
  ├─ BrowserWindow -> preload (dist/preload/preload.cjs) -> shared App
  │     window.desktop.connection() -> ipc desktop.connection -> {origin, token, profileID}
  │     pickDirectory / openPath / revealPath / enableNotifications
  └─ endo://app protocol handler -> bundled renderer files (release builds)

renderer -> http://127.0.0.1:<port> (tRPC, SSE), every request carrying the
            run token as Authorization: Bearer
```

Main only hosts: it starts and supervises the backend, opens windows, and
executes host capabilities the backend requests, such as showing a system
notification. The `parentPort` protocol (`src/host-protocol.ts`) has four
messages: `init`, `ready`, `notify` and `shutdown`. Main holds no business
logic and keeps no copy of application state. The backend is the single runtime:
one SQLite database under its home, one `createServer()` shared by every window.

Startup: main takes the single-instance lock, creates the home directory,
generates a 32-byte run token, forks the backend and posts `init`. The backend
runs `createServer()` with that home and the loopback access guard, listens on
`127.0.0.1:0` and posts `ready`; main registers `desktop.connection` and creates
the window only then. No `ready` within 30 s, or an exit before it, kills the
child and shows the startup error. Model runtimes install in the background
(`models.installOnStartup`) and never block readiness.

App identity: release builds are named `Endo` (home `~/.endo`),
development builds `Endo Development` (home `~/.endo-dev`), which also
isolates Electron userData. `--endo-home=<path>` selects an explicit home.

Network defaults: `backend-entry.ts` allows 1 s per address when connecting
(Node's default of 250 ms is shorter than one round trip to distant hosts) and
keeps idle `fetch` connections for 30 s through a global `undici` Agent.

## Security

The backend answers only requests whose Host is its bound address, whose Origin
is the renderer origin (`endo://app`, or the Vite origin in development),
and which carry the run token as `Authorization: Bearer` (the fetch-based
EventSource sends it for SSE too). The token lives only in memory, never in
argv, storage, URLs or logs, and changes every launch. IPC handlers answer only
a window's main frame at the renderer origin.

Renderer sandboxing and context isolation are enabled and Node integration is
disabled. Pages may write to the clipboard; every other permission, including
device access, is denied, as are new windows. External HTTP(S) links open in
the system browser. The packaged CSP allows only bundled files, Blob/data URLs
for previews, and connections to the backend's HTTP origin. Release
builds ignore the development URL.

`desktop.pickDirectory` opens a native single-folder picker; `desktop.openPath`
and `desktop.revealPath` open or reveal an absolute local path through
`shell`. `desktop.enableNotifications` shows a confirming notification, which is
what lets macOS ask the user for permission.

## Quit

Open editors first resolve their `beforeunload` decision; canceling keeps the
backend available for saving. Once windows accept closing, `will-quit` posts
`shutdown`; the backend runs `server.shutdown()` and exits 0. Main kills it
after 5 s but treats only the exit event as confirmation, then quits. A Quit
during startup never starts the backend or a window. Repeated Quit requests
share one shutdown. An unexpected backend exit shows a Relaunch/Quit dialog.

## Bundles and packaging

`scripts/tooling.ts` produces `dist/main/main.js`, `dist/main/backend.js` (a
Vite SSR bundle of `backend-entry.ts` with every dependency inlined except
`electron`, `@anthropic-ai/claude-agent-sdk`, `typescript` and Node
builtins, which are copied into `dist/node_modules`), `dist/preload/preload.cjs`
and `dist/renderer/`. The server's prompt `.txt` files, workflow templates and
workflow SDK typings are emitted beside the backend. `node:sqlite` is a builtin,
so nothing native is rebuilt.

```sh
just desktop-build [development|production]    # runtime + renderer, no package
just desktop-package [development|production]  # Electron Packager bundle
```

Packaging is ad-hoc signed. Set `ENDO_SIGNING_IDENTITY` (a Developer ID) and
optionally `ENDO_NOTARY_PROFILE` (a `notarytool` keychain profile) for a
distributable macOS build. `just desktop-release` requires Developer ID signing,
notarizes/staples the app and DMG, and writes a ZIP, checksums and `RELEASES.json`.
`just desktop-publish <version>` publishes those exact artifacts. See the
[release runbook](../operations/desktop-release.md).

Signed, notarized Apple Silicon production builds embed the Endo update feed
(`https://downloads.longsurf.ai/endo/darwin/arm64`). Development, ad-hoc and
unsupported-platform builds never start the updater. Electron checks at launch
and every ten minutes, downloads an available update, and reports the release
through guarded main IPC and AppHost. The sidebar offers a restart; newly opened
windows recover the waiting release. Subscription disposal removes the listener
and suppresses a pending snapshot. The restart follows normal Quit so unsaved
editors can cancel before the backend stops. A normal quit also applies a
previously downloaded update on the next launch. Network failures are logged and
retried on the next scheduled check.

Endo uses its own bundle ID, browser storage and profile (`~/.endo`). Existing
Reagent profiles are not moved or deleted. To reuse one, quit Reagent first and
launch Endo with `--endo-home=<existing-profile>`; provider login and browser
preferences may need to be set again.

## Changelog

`src/changelog/changelog.json` feeds Settings → Changelog through
`AppHost.changelog`; its newest entry must match `package.json`'s version. See
[its rules](../../platform/desktop/src/changelog/AGENTS.md).
