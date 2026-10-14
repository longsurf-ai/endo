# styles

Read [the OpenChart design contract](../../DESIGN.md) before changing visual values.

- `globals.css` is the app global CSS entry.
- `themes.css` owns Gray light/dark surfaces, shared Neutral primary colors,
  and compatibility tokens for data consumers. Color values are complete CSS colors.
  Tailwind projects these tokens; TypeScript must not repeat the palette.
- Both palettes declare identical keys. Shared derived aliases apply to `:root`,
  `.light`, and `.dark` so nested theme previews recompute locally.
- `fonts.css` bundles Inter. Heading and body roles share this family.
- Shared styles contain tokens, fonts, element defaults, and generic utilities.
  Feature selectors and layouts stay with consumers.
- The main surface and sidebar use distinct backgrounds. Sidebar gradient
  and geometry belong to the sidebar primitive, not the global stylesheet.
- Keep theme tests for default values, scope parity, acyclic references, and generated
  utility resolution.
