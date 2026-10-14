# Notification sounds

- One immutable catalog owns sound IDs, labels, filenames and preview assets.
  App, Config and Desktop consume it; this package has no runtime service.
- Assets are local PCM WAV. Keep conversion, hashes and durations in
  `manifest.json`. Never copy unlicensed service audio here.
- Desktop packages these same files outside ASAR for macOS notification lookup;
  Vite bundles the literal URLs for previews. No remote playback or file paths
  supplied by users.
