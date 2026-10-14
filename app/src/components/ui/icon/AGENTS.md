# icon

The retained Hugeicons renderer for existing OpenChart consumers. Shell surfaces use
Lucide glyphs directly, with the shared theme's SVG defaults.

## Invariants

- Consumers import individual glyphs from `@hugeicons/core-free-icons/<Name>Icon`
  and render them through `Icon`. Keep SVG rendering in the official package;
  do not introduce a string registry or dynamic loader.
- CSS owns size, stroke, and theme colors. The wrapper applies shared defaults
  and makes child strokes inherit the root width so icon-pack attributes cannot
  override our tokens. Use Tailwind classes to select size and weight.
- Icons are decorative by default. Controls own accessible names; standalone
  meaningful icons explicitly supply `aria-hidden={false}`, a role, and a label.
- Named OpenChart brand marks remain in `components/ui/brand`.
