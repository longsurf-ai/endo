# command

Owns slash-command definitions, template expansion and Part construction.

- `commands/` has one definition per file; `catalog.ts` explicitly registers them.
  Commands declare their own argument schemas and never import workflow programs.
  Predefined workflow commands reference `default:workflows/*.workflow.ts`.
- Preserve quoted-argument tokenization, highest-position rest capture,
  `$ARGUMENTS` and no-placeholder append.
- `buildCommand` takes only a command name and arguments, returning input Parts.
  It never submits, enqueues or wakes execution. Callers assemble the complete
  prompt and submit through `agent.prompt`, which owns composition validation.
- Frontend receives serializable descriptions/hints and constructed Parts.
  Functions and argument schemas remain server-owned. Feature owners retain
  execution and constraints.
- Define every command with `defineCommand`, binding `template`, `buildParts`,
  and `restoreArgumentsFromParts`. Raw callbacks stay private and pure.
  Construction must restore/recompile its Parts before returning; a broken
  inverse is an internal defect, not invalid user arguments. Restoration must
  rebuild/deeply compare all Parts and their order; unsupported input fails.
  Both directions use raw compilation internally, never recursive checked calls.
  Preserve the composer's reversible subset in `app/src/lib/prompt-converter/AGENTS.md`.
