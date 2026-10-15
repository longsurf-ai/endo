# Endo

A desktop framework: Electron, chat, native agents, workflows, Resources,
schedules and workspaces. Extracted from OpenChart; packages retain `@openchart/*`.

Prefer simple designs and one source of truth. Read the owner's
AGENTS.md and [architecture](docs/architecture/code-organization.md) before editing.

## Boundaries

- Desktop hosts the server; shared code never imports platforms. Common never
  imports app/server. App's server imports are type-only contracts.
- Features compose at the app root; product bindings belong in server. New
  user data is a Resource (`server/resources/<name>/`, registered in
  `catalog.ts`); follow existing owner patterns and descriptive names.
- Effect errors live at their owner. Before Effect changes, read
  [Effect's guide](node_modules/effect/AGENTS.md).
- Read [app/DESIGN.md](app/DESIGN.md) before UI changes. Use Computer Use for
  desktop verification. Draw diagrams in fenced Mermaid blocks.

## Commands and documentation

From root use `just`: `install`, `desktop`,
`check`, `format-fix`. `just check` must pass before opening a PR.
Public APIs need self-contained TSDoc: behavior, ownership, cleanup,
failures, and examples. Keep local AGENTS.md files under 200 words.

## Public content

Keep credentials, internal plans, and machine-local state outside this repository.
Write English prose; preserve Unicode tests. Preserve human annotations between HUMAN-ANNOTATION markers:
only formatting changes need no explicit human authorization;
wording, meaning, marker, location, or scope changes require it.
