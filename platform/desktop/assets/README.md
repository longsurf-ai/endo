# Endo desktop icon

The canonical artwork is [endo.png](../../../app/src/components/ui/brand/endo.png).
Use the supplied colors, shape and white background unchanged. The app sidebar,
favicon and repository README use that same image.

`icon.icns` is a checked-in macOS export used by development and production
packages. Regenerate it from the repository root on macOS:

```sh
just desktop-icons
```

The command uses Apple's `sips` and `iconutil` to resize the source into standard
icon sizes. Intermediate files stay under `.artifacts/Endo.iconset`. Ordinary
builds use the checked-in export and do not regenerate artwork. Rebuild
`just desktop` to see the new native icon.
