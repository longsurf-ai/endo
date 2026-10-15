# Demo media

Sources for the README demo. Nothing here ships with the app, and
`demo/media/` is excluded from Prettier.

| Path              | Contents                                                                      |
| ----------------- | ----------------------------------------------------------------------------- |
| `readme-loop.gif` | The README demo: 960×540, 15 fps, 14.4 s, loops.                              |
| `readme-loop/`    | HyperFrames project for the GIF. Renders go to the ignored `renders/` folder. |

## Rebuild the README loop

`readme-loop/tools/build.mjs` generates `index.html`: the app scenes are HTML
laid over `assets/home.jpg`, and the imagined workflows are drawn in SVG.

```sh
cd demo/media/readme-loop
node tools/build.mjs
npx hyperframes check
npx hyperframes render . -q high -o renders/video.mp4
ffmpeg -i renders/video.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff" /tmp/palette.png
ffmpeg -i renders/video.mp4 -i /tmp/palette.png -lavfi "fps=15,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" -loop 0 ../readme-loop.gif
```

`npx hyperframes preview` opens the project in Studio for direct edits.
