# Demo media

Sources for the README visuals. Nothing here ships with the app, and
`demo/media/` is excluded from Prettier.

| Path                     | Contents                                                                      |
| ------------------------ | ----------------------------------------------------------------------------- |
| `readme-loop.gif`        | The hero demo: 960×540, 15 fps, 14.4 s, loops.                                |
| `readme-loop/`           | HyperFrames project for the hero. Renders go to the ignored `renders/` folder. |
| `feature-*.gif`          | Key-feature loops cut from real Endo recordings: 960×630, 12 fps.             |
| `features/`              | Edit lists, clips and HyperFrames projects for the feature loops.             |
| `star-endo.gif`, `star/` | The Star animation at the end of the README, and its source and renderer.     |

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

## Rebuild the feature loops

The feature loops are real Endo sessions (Codex, Claude Code and Antigravity
answering live), recorded as CDP screencasts of the packaged development app in
a temporary profile. `features/tools/spec.mjs` cuts each recording into one
clip and places the camera; `remap.mjs` writes `<feature>/assets/clip.mp4` and
`timing.json`, and `build.mjs` adds the window, cursor and clicks.

```sh
cd demo/media/features
node tools/remap.mjs <recordings-dir>   # only when re-cutting raw recordings
node tools/build.mjs
sh tools/gif.sh
```

To record again, package the development app (`just desktop-package development`)
and start it with `--use-mock-keychain --user-data-dir=<tmp>/browser
--endo-home=<tmp>/home --remote-debugging-port=9333`, with signed-in providers
and `tools/record/compose.workflow.ts.txt` copied into the default workspace as
`compose.workflow.ts`. Then run each script in order (`recA`, `recA2`, `recC`,
quit and reopen the app, `recC2`, `recB`), for example
`node tools/record/cdp.mjs tools/record/recA.mjs <recordings-dir>/A`.

## Rebuild the Star animation

Open `star/star-endo.html` to preview it. With Playwright's Chromium installed
(`npm --prefix platform/desktop exec -- playwright install chromium --only-shell`),
run `node demo/media/star/render.mjs` from the repository root.
