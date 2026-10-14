# workflow authoring

`index.ts` is the sole public authoring API. The workspace loader binds
`@openchart/workflow` to this host-owned module; no package is installed into
the user's workspace. Shipped templates use the same file authoring import.
Programs import only their public entrypoint; primitives, shared helpers, and
backend services stay internal.

- Keep each primitive in its own file and explicitly export it from `index.ts`.
- Put shared implementation helpers in `shared/`; do not expose them through
  the public index.
- `phase(name, effect)` scopes progress through spans; Effect owns parentage,
  cleanup and cancellation. Publish start and terminal state through tracing.
- Runtime and host own invocation limits, child Sessions, and cancellation.
  Primitives use those capabilities without creating a second runtime.

See [workflow architecture](../../../../docs/architecture/workflow.md).
