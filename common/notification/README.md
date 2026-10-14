# Bundled notification sounds

Each recording is mono 44.1 kHz, 16-bit PCM WAV for native macOS notifications
and browser previews, reduced by 6 dB, without looping, trimming or synthesizing
replacement sounds. All are shorter than one second. `manifest.json` records the
conversion command, output SHA-256 and durations.

The identical WAV files are copied into the macOS Resources directory and
bundled by Vite for previews. Playback requires no network access.
