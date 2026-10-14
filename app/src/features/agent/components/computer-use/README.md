# Computer Use

`computer-use.tsx` renders the browser chrome, surface tokens, cursor, trail,
step counter, and index normalization. The footer shows only the right-aligned
step counter, without action/target labels. `surfaces.ts` and `range.ts` hold
only the styles and index helpers it uses.

The shared `components/ui/floating-viewer` owns drag and four-corner docking.
The feature wrapper only wires screenshot controls and minimization.
AgentLayout supplies its viewport bounds above the composer/footer, keeping
the preview clear of the sidebar, header and composer as they resize.
Playback applies the translucent black surface through the `className` prop,
with a local dark scope for readable foreground colors.
Playback reads the latest user turn's ordered screenshots from the canonical
AG-UI transcript; it adds no frame store or provider protocol. Previous/next
selection is local, and following the newest frame is the default. Decorative
cursor coordinates are deterministic presentation data, not recorded input.
