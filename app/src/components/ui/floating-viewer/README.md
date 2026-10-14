# Floating Viewer

Interaction: whole-surface Motion dragging, viewport constraints,
`dragElastic={0.08}`, no momentum, pointer-quadrant selection of the four corners,
`{ type: "spring", bounce: 0, duration: 0.4 }`, 16px edge padding, 320px width,
corner cycling button, reduced-motion behavior, and docking after resizing.

- Always floating: there is no inline anchor, automatic detachment, or
  restore/close action. Consumers own visibility.
- Content determines height. Space above it is reserved for the toolbar, so
  controls do not obscure the consumer's UI. The toolbar stretches to the content
  width with a black translucent surface and buttons, a consumer controls slot,
  and native disabled/pressed button props.
- Measure before paint for immediate initial placement. Stop in-flight animation
  when dragging starts or the component unmounts; keep resize listener/observer cleanup.
- Allow host-supplied bounds for layout clearance. Desktop excludes the
  `data-slot="floating-viewer"` surface from native window dragging.

The component has no Agent, screenshot, playback or transcript knowledge.
Computer Use composes it with its screenshot view.
