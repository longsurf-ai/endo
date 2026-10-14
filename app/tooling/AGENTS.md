# app tooling

Own regression checks and the browser test environment for the app's development tools.

## Invariants

- `jsdom-environment.ts` keeps Node's Fetch and AbortController/AbortSignal
  constructors together; jsdom supplies the DOM and owns environment cleanup.
  Navigation tests must exercise real Request construction and cancellation.
  jsdom owns Web Storage; Node's built-in localStorage stubs never reach tests.
- Exercise the shared OpenChart ESLint configuration and `npm run lint` command. Do not
  duplicate their rules in test-only configurations. Keep one CLI smoke test
  for command wiring and reuse an ESLint instance for rule assertions.
- Editor-style ESLint instances and CLI processes must agree on app aliases,
  Tailwind tokens, independently of the process directory. Prettier owns class order.
- A long-lived ESLint instance must pick up Tailwind config edits. Generated CSS
  must never make an invalid utility pass lint.
- Use virtual source and temporary directories; never modify application source
  or its live Tailwind configuration to test failure cases.
- Verify formatting stays in Prettier, Hooks checks, native-platform and feature
  import boundaries, and ignored build output from repository, app,
  and nested source working directories.
