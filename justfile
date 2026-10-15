# Purpose: Development, validation, and desktop packaging commands.

default: check

# Install dependencies and update the lockfile.
install *flags:
    bun install {{flags}}

# Exercise workspace authoring and the real workflow runtime.
workflow-test:
    npm exec vitest -- run server/agent/workflow server/workspace

# Measure Workspace I/O on a reproducible large temporary directory.
workspace-benchmark:
    WORKSPACE_BENCHMARK=1 npm exec vitest -- run server/workspace/benchmark.test.ts

# Run the shared application in Electron; main hosts the server in a utility process.
desktop:
    npm --prefix platform/desktop run dev

# Start the headless Agent backend demo.
[arg('name', pattern='agent', help='Demo to launch')]
demo name:
    npm --prefix 'demo/{{name}}' run dev

# Build bundled Electron files without a development server.
desktop-build environment="production":
    npm --prefix platform/desktop run build -- '{{environment}}'

# Package the complete app; production signs with ENDO_SIGNING_IDENTITY when set.
desktop-package environment="production":
    npm --prefix platform/desktop run package -- '{{environment}}'

# Produce signed, notarized Apple Silicon installers and the website update feed.
desktop-release:
    npm --prefix platform/desktop run release

# Regenerate macOS icons from the app's canonical Endo artwork.
desktop-icons:
    #!/usr/bin/env bash
    set -euo pipefail
    iconset="$PWD/platform/desktop/.artifacts/Endo.iconset"
    artwork="$PWD/app/src/components/ui/brand/endo.png"
    mkdir -p "$iconset"
    for size in 16 32 128 256 512; do
      sips --resampleHeightWidth "$size" "$size" "$artwork" --out "$iconset/icon_${size}x${size}.png" >/dev/null
      double=$((size * 2))
      sips --resampleHeightWidth "$double" "$double" "$artwork" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
    done
    iconutil -c icns "$iconset" -o platform/desktop/assets/icon.icns

# Upload verified downloads, then the update manifest, then the GitHub Release.
[arg('version', pattern='[0-9]+\.[0-9]+\.[0-9]+')]
desktop-publish version:
    #!/usr/bin/env bash
    set -euo pipefail
    cd 'platform/desktop/out/release/{{version}}'
    release_directory="$PWD"
    shasum -a 256 -c SHA256SUMS
    test "$(jq -r .currentRelease RELEASES.json)" = '{{version}}'
    git show "$(cat SOURCE):platform/desktop/src/changelog/changelog.json" | jq -r '.[] | select(.version == "{{version}}") | .items[] | "- \(.)"' > NOTES.md
    test -s NOTES.md
    for extension in dmg zip; do
      file="Endo-{{version}}-darwin-arm64.$extension"
      npx --yes wrangler@4.135.0 r2 object put "openchart-releases/endo/darwin/arm64/$file" --remote --file "$release_directory/$file" --cache-control 'public, max-age=31536000, immutable'
    done
    npx --yes wrangler@4.135.0 r2 object put 'openchart-releases/endo/darwin/arm64/SHA256SUMS-{{version}}' --remote --file "$release_directory/SHA256SUMS" --content-type text/plain --cache-control 'public, max-age=31536000, immutable'
    npx --yes wrangler@4.135.0 r2 object put 'openchart-releases/endo/darwin/arm64/Endo.dmg' --remote --file "$release_directory/Endo-{{version}}-darwin-arm64.dmg" --content-type application/x-apple-diskimage --content-disposition 'attachment; filename="Endo-{{version}}-darwin-arm64.dmg"' --cache-control no-store
    npx --yes wrangler@4.135.0 r2 object put 'openchart-releases/endo/darwin/arm64/RELEASES.json' --remote --file "$release_directory/RELEASES.json" --content-type application/json --cache-control no-store
    # Mirror the release on GitHub, tagged at its source commit, and mark it latest.
    if gh release view 'v{{version}}' --repo longsurf-ai/endo >/dev/null 2>&1; then
      gh release edit 'v{{version}}' --repo longsurf-ai/endo --latest
    else
      gh release create 'v{{version}}' Endo-{{version}}-darwin-arm64.dmg Endo-{{version}}-darwin-arm64.zip SHA256SUMS --repo longsurf-ai/endo --target "$(cat SOURCE)" --title 'Endo {{version}}' --notes-file NOTES.md --latest
    fi

# Verify a packaged Electron executable; all test data stays in a temporary profile.
[arg('keychain', pattern='mock|system')]
desktop-smoke executable environment="production" keychain="mock":
    npm --prefix platform/desktop run smoke -- '{{executable}}' '{{environment}}' '{{keychain}}'

# Run every check once in parallel; every dependency must succeed.
[parallel]
check: check-static typecheck test

# Validate schema drift, lint, and formatting.
check-static:
    npm run check:static

# Migration generation contract:
#
# `name` is the descriptive suffix in `<timestamp>_<name>.ts`.
# Drizzle compares declarations in `server/agent/**/schema.ts` and
# `server/resources/**/schema.ts` with `server/db/schema.json`, which records the schema state after the latest
# generated migration.
#
# When a schema difference exists, this command writes one new migration under
# `server/db/migration/` and advances `server/db/schema.json`. It always rebuilds
# `server/db/schema.gen.ts` for fresh databases and `server/db/migration.gen.ts`
# for the ordered migration registry and source checksums.
#
# This command generates artifacts only; it does not open an application
# database or apply migrations. Schema DDL is generated rather than handwritten.
# Add required data backfills or persisted-JSON transformations to the newly
# generated migration before it can reach a durable database. Once a migration
# may have been applied, never edit, delete, rename, or reorder it; create a new
# forward migration instead. If a new migration receives a handwritten data
# step, rerun this command to refresh its registry checksum, then run
# `just check`.
#
# Generate one forward-only SQLite migration from the application schemas.
# `hints` answers drizzle-kit's rename prompts as JSON, e.g.
# '[{"type":"create","kind":"table","entity":["public","note"]}]'.
migration name hints="":
    npm --prefix server run db:generate -- --name {{name}} {{ if hints == "" { "" } else { "--hints " + quote(hints) } }}

# Lint every source file.
lint:
    npm run lint

# Apply safe ESLint fixes to every source file.
lint-fix:
    npm run lint:fix

# Check formatting with the one Prettier policy.
format:
    npm run format

# Format selected files, or all files when omitted.
format-fix *files=".":
    npm exec prettier -- --write {{files}}

# Apply lint fixes, then format.
fix:
    npm run fix

# Run all tests with Vitest.
test:
    npm test

# Run selected app tests. Paths are relative to app/.
[working-directory: "app"]
test-app *files:
    npm exec vitest -- run {{files}}

# Run selected common/server tests without starting the app suites.
test-core *files:
    npm run test:core -- {{files}}

# Type-check every workspace.
typecheck:
    npm run typecheck
