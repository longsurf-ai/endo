# Brand

App-owned React brand marks. OpenChartMark matches the OpenChart glyph in
`platform/desktop/assets/logo.svg`. Third-party marks (Discord, GitHub) keep their official
geometry.

## Invariants

- Marks inherit color through `currentColor`, except a third-party mark with an
  official color (Discord, Antigravity), which owns it in every theme like `ClaudeLogo`.
- Consumers own brand text, accessible labels, sizing, and navigation behavior.
