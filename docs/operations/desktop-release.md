# macOS desktop releases

Release Endo for Apple Silicon from a signing Mac. Run commands from the
repository root. Merging a PR does not publish an application update.

## Signing and hosting

- Use an Apple Silicon Mac with Node 24, Bun, Just, `jq`, and full Xcode selected
  with its command-line tools available.
- Install Longsurf's Developer ID Application certificate and its private key
  in the signing Mac's Keychain. Keep the signing team and `ai.longsurf.endo`
  bundle ID stable across releases.
- The release command defaults to `Developer ID Application: Longsurf, Inc.`
  and the existing `openchart-notary` Keychain profile. Both can be reused for
  Endo under the same team. Override with `ENDO_SIGNING_IDENTITY` and
  `ENDO_NOTARY_PROFILE` when using another signing setup.
- Configure missing notarization credentials interactively with
  `xcrun notarytool store-credentials openchart-notary`. Keep credentials out of
  source control and command arguments.
- Publishing requires Cloudflare access to the existing `openchart-releases`
  R2 bucket and its `downloads.longsurf.ai` domain. Endo uses only the separate
  `endo/darwin/arm64/` prefix; OpenChart's downloads and feed are untouched.
- Sign `gh` into an account allowed to create releases in `longsurf-ai/endo`.

## Prepare and build

Bump `platform/desktop/package.json` to a new `x.y.z` version and add its entry
to `platform/desktop/src/changelog/changelog.json`. Commit the release source.
Published versions are immutable: corrections require a higher version.

```sh
just install --frozen-lockfile
just check
just desktop-release
```

The release command builds the runtime, signs and notarizes the app, then creates
and verifies these files under `platform/desktop/out/release/<version>/`:

| File                              | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `Endo-<version>-darwin-arm64.dmg` | Signed, notarized installer with an Applications shortcut |
| `Endo-<version>-darwin-arm64.zip` | Signed, stapled application for automatic updates         |
| `SHA256SUMS`                      | Download checksums                                        |
| `RELEASES.json`                   | Version and ZIP URL for Electron's static update feed     |
| `SOURCE`                          | Exact source commit to tag when publishing                |

Apple processing may take time. The finished release directory appears only
after verification succeeds. Keep these exact artifacts; rebuilding produces
different signed bytes. This command does not publish downloads.

For local testing without Apple credentials, use `just desktop-package` or
`just desktop-package development`. Ad-hoc packages do not check for updates.

## Verify

```sh
release_version=$(node -p "require('./platform/desktop/package.json').version")
release_app="$PWD/platform/desktop/out/$release_version/Endo-darwin-arm64/Endo.app"
just desktop-smoke "$release_app/Contents/MacOS/Endo" production system
```

The smoke uses an isolated profile and a model CLI fixture. Also install the
downloaded DMG on another Mac or a separate account and verify Gatekeeper accepts
it, connect a real provider, run a chat, and confirm data survives a restart.
Before rolling out an update, test upgrading from the previous signed release,
including a dirty workspace editor: canceling the restart must keep editing and
saving available. The first release establishes the installation; a subsequent
version is required to verify a real upgrade.

Endo stores data under `~/.endo` and has its own browser profile. The rename does
not move or delete Reagent's existing data. To reuse it, quit Reagent and launch
Endo with `--endo-home=<existing-profile>`. Browser preferences and provider login
may need to be set again. Do not run both apps against the same profile.

## Publish

```sh
just desktop-publish "$release_version"
```

Publishing uploads the versioned DMG/ZIP and checksums first, then the stable
`Endo.dmg` download and `RELEASES.json`, then creates the GitHub Release tagged at
`SOURCE`. Versioned objects are immutable-cacheable; the stable download and
manifest use `Cache-Control: no-store`.

The website's Download for Mac button can link to
`https://downloads.longsurf.ai/endo/darwin/arm64/Endo.dmg` after the first publish.
The updater reads `https://downloads.longsurf.ai/endo/darwin/arm64/RELEASES.json`.
Verify both public URLs and compare the downloads against `SHA256SUMS`.

Signed, notarized production apps check at startup and every ten minutes. A
downloaded update exposes a sidebar restart button; it also applies on the next
normal quit and launch. The feed is compiled into the app and cannot be changed
by a runtime environment variable. Development builds and other architectures
never update. The current feed has one stable channel and no staged rollout.

If an update is bad, publish a fixed higher version. Do not replace an existing
version's bytes or expect clients to downgrade automatically. Repointing the
stable DMG alone changes fresh installs, not the update feed.
