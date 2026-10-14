# resources

<!-- HUMAN-ANNOTATION:START -->

- Prefer Transitions to express Resource operations.
- Keep all Resource management logic in `resources/`; do not scatter it across other modules.
- Runtime behavior (how Resources are used) may live in other modules.
- Tools may call Transitions; the generic `resource_mutate` only provides intrinsic operations.

| Concept                                  | Contract                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                              | Database tables, columns, constraints, relationships; persistence source of truth.                                                                                                                                  |
| `entity.ts`                              | Complete runtime shape, derived from database schema plus envelope, validation and annotations.                                                                                                                     |
| `<resource>.ts`                          | Must contain only Resource definitions; no implementation logic.                                                                                                                                                    |
| Intrinsic transitions                    | Framework-generated `get/list/listAll/create/patch/remove`; never override for business behavior. `listAll` stays internal; `remove` maps to API `delete`.                                                          |
| `<resource>/transitions/<transition>.ts` | Resource-local business operations must live in `<resource>/transitions/`, with input schema and `resolve/apply`; registered declarations automatically become named tRPC queries or mutations according to `kind`. |
| `./macro/<macro>.ts`                     | Ordinary Transition composing multiple Resources' transitions through one `Transactor.run`; no direct SQL/Store access.                                                                                             |
| `readOnly: true`                         | Hides public intrinsic `create/patch/delete` only. tRPC keeps `get/list` and custom transitions. Internal operations remain complete.                                                                               |

<!-- HUMAN-ANNOTATION:END -->

**IMPORTANT:** Whenever you encounter bespoke logic, consider whether it belongs in the owning Resource's `transitions/` directory.

Framework: [lib/resource](../lib/resource/AGENTS.md). Composition: [macros](macros/AGENTS.md).

- `catalog.ts` owns registration/`ResourceName`; import `resource.ts`. `router.ts` aggregates derived children and `macro-router.ts`; server root mounts once under `resources`. Single-Resource queries use declared transitions; cross-Resource APIs use `resources.macro.*`.
- Stores own SQL; bounded windows precede joins. `listAll` paginates within one transaction.
- Import Agent contracts from `@openchart/server/agent/contracts/*`, never execution modules; Agent schema imports: FKs/read projections only.
- Schedule owns definitions/cursors; Occurrence owns acceptance history with required Schedule/Run FKs. Schedule deletion cascades Occurrences, preserving Runs/Sessions. CRUD never executes targets.
