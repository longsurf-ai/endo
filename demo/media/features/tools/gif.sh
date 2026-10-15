#!/bin/sh
# Renders each feature composition and encodes demo/media/feature-<name>.gif.
# Usage from demo/media/features: sh tools/gif.sh [feature ...]
set -e
cd "$(dirname "$0")/.."
for f in ${*:-agents workflow dig-in}; do
  (cd "$f" && npx --yes hyperframes@0.8.159 render . -q high -o renders/video.mp4 >/dev/null)
  palette="$(mktemp -t endo-palette).png"
  ffmpeg -v error -y -i "$f/renders/video.mp4" -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff" "$palette"
  ffmpeg -v error -y -i "$f/renders/video.mp4" -i "$palette" -lavfi "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" -loop 0 "../feature-$f.gif"
  rm -f "$palette"
  ls -la "../feature-$f.gif"
done
