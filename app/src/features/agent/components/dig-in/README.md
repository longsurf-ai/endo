# Dig In presentation

`dig-in-marker.tsx` renders the inline underline, hover and keyboard-focus
treatment. The mark opens its saved child Session and composes the existing
`ShimmerLabel`.

The rehype plugin retains the Markdown tree and annotates prose text with stable
rendered offsets. Selection and restored anchors use that same coordinate space.
Code/math renderers own their own DOM and are excluded from Dig In selections.
Quote selection uses assistant-ui's selection toolbar.
