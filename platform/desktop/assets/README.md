# Desktop icon

`logo.svg` is the vector master; `icon.svg` composes it on a white macOS tile.
The master is the symbol from [OpenChart — Vector Identity](https://www.figma.com/design/RRd48shsc2d2oP8G16Aqqg).
The vector master owns the paths; do not redraw them separately for packaging.
`icon.icns` is a checked-in export, used by development and production packages.

Regenerate from the repository root on macOS with `rsvg-convert` (librsvg) and Apple's `iconutil`:

```sh
iconset="$PWD/platform/desktop/.artifacts/OpenChart.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" platform/desktop/assets/icon.svg -o "$iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  rsvg-convert -w "$double" -h "$double" platform/desktop/assets/icon.svg -o "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o platform/desktop/assets/icon.icns
```

Asset generation is needed only when the icon changes. Ordinary builds need no
SVG converter. Rebuild `just desktop` to preview the native icon. The App sidebar
retains its OpenChart text label.
