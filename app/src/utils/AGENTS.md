# utils

Shared application utilities; no feature or app composition dependencies.

## Invariants

- `cn` merges classes using Tailwind's conflict rules, including the semantic
  icon dimensions in the app's Tailwind configuration. Later explicit sizes must
  replace defaults. Keep token values in CSS, never in the merge configuration.
- Preserve responsive variants and keep icon color independent from stroke width.
