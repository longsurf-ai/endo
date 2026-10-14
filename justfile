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

# Package the complete app; production signs with REAGENT_SIGNING_IDENTITY when set.
desktop-package environment="production":
    npm --prefix platform/desktop run package -- '{{environment}}'

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
