# Develop Reagent

This repository contains the Reagent desktop app (Electron) and its local server.

## Run from source

Install Git, [Node.js 24](https://nodejs.org/en/download),
[Bun 1.4.2](https://bun.sh/docs/installation), and [Just](https://just.systems/man/en/).

```sh
just install --frozen-lockfile
just desktop
```

Run commands from the repository root. `just desktop` builds the Electron host
and backend, starts Vite for live renderer updates, and opens
`Reagent Development` with a profile under `platform/desktop/.artifacts/dev-profile`.
On first start the app installs pinned Codex, Claude Code and Antigravity CLIs
into that profile in the background; each uses your existing login for that CLI
(`codex login`, `claude login`, …), or sign in from Settings → Models.

`just demo agent` starts only the backend on `127.0.0.1:43873` with a temporary
home, for Agent work without Electron.

## Build

```sh
just desktop-build                 # bundles without a development server
just desktop-package development   # ad-hoc signed development .app
just desktop-package               # production identity (Reagent.app)
```

Generated bundles go to `platform/desktop/dist/`; packaged applications go to
`platform/desktop/out/` (development packages to `.artifacts/dev`). Set
`REAGENT_SIGNING_IDENTITY` and optionally `REAGENT_NOTARY_PROFILE` to sign and
notarize a production macOS package.

## Repository

| Directory           | Responsibility                                             |
| ------------------- | ---------------------------------------------------------- |
| `app/`              | React interface: chat, schedules, workspace, settings      |
| `server/`           | Local backend: Agent runtime, Resources, scheduler, SQLite |
| `common/`           | Shared packages: model providers, identifiers, utilities   |
| `platform/desktop/` | Electron host and packaging                                |
| `docs/`             | Architecture contracts                                     |

Read the owning directory's `AGENTS.md` and the
[code organization guide](architecture/code-organization.md) before changing code.
Read [app/DESIGN.md](../app/DESIGN.md) before changing the interface. To add user
data, follow [Adding a Resource](architecture/resource.md#adding-a-resource).

## Checks

```sh
just check                      # Schema, lint, formatting, types, and tests
just format-fix path/to/file    # Format only the files you changed
just migration <name>           # Generate a migration after changing a schema.ts
```

Keep internal plans, local profiles, and credentials outside this repository.
Use English for authored documentation and comments. Preserve human annotations
as described in [AGENTS.md](../AGENTS.md).
