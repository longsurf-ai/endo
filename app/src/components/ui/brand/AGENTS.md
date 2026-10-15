# Brand

App-owned React brand marks. `endo.png` is Endo's canonical transparent artwork;
`EndoMark` displays it, README references it, and `just desktop-icons` exports the
native app icon. Third-party marks retain their official geometry.

## Invariants

- Endo's artwork retains its colors and transparent background in every theme.
  Keep the tight framing so the mark remains legible at small sizes.
  Vector marks inherit `currentColor`, except official colored third-party marks.
- Consumers own brand text, accessible labels, sizing, and navigation behavior.
