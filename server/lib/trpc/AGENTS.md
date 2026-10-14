# trpc

Owns the shared router builder and reusable transport adapters.

- Use server Context and trpc.ts; create no alternate runtime, context, or mount.
- Every procedure, including parsing/subscriptions, inherits the shared error
  boundary. Detect request cancellation before classification; retain local causes
  without exposing stacks/raw defects. Enumerate public error fields explicitly.
- Domain classification belongs in lib/errors, never procedure handlers or
  message-string inspection. Preserve structured Resource diagnostics.
- resource-router derives procedures from definitions, parses once through strict
  Effect Standard Schema, binds input, and executes Transactor.run. Preserve
  encoded/decoded types, async codecs, errors, and Effect service requirements;
  casts must not conceal unavailable dependencies.
- Custom declarations use `kind: "query"` for reads; omitted kinds are mutations.
  Runtime routes and client types retain that kind and the declaration schema.
  Resource core imports neither tRPC nor Context; this folder imports no concrete Resource.
- Shared Resource schemas own filters/cursor decoding; returned tokens are already
  encoded. Omitted list input uses shared bounded defaults. No local cursor format.
- readOnly omits only intrinsic create/patch/delete in runtime and client types;
  custom transitions and get/list remain public. listAll stays internal.
  Stores/transitions retain complete internal capabilities.
- resources/catalog owns registration; resources/router aggregates. This adapter
  owns no business operation rules.
