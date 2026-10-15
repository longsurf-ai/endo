# Endo desktop icon

The canonical artwork is [endo.png](../../../app/src/components/ui/brand/endo.png).
It preserves the supplied ribbon design with a transparent background and tight
framing: the mark fills about 90% of the image height. The app sidebar, favicon,
repository README and native app icon use that same image without a background
tile, so the artwork stays legible at small sizes.

`icon.icns` is a checked-in macOS export used by development and production
packages. Regenerate it from the repository root on macOS:

```sh
just desktop-icons
```

The command uses Apple's `sips` and `iconutil` to resize the source into standard
icon sizes. Intermediate files stay under `.artifacts/Endo.iconset`. Ordinary
builds use the checked-in export and do not regenerate artwork. Rebuild
`just desktop` to see the new native icon.
