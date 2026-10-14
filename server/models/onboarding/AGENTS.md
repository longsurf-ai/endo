# Provider onboarding

Owns the app manifest, managed downloads, startup reconciliation and login jobs.

- Manifest is the sole version/download authority. Pin official archives (npm or
  flat GitHub release tarballs) and hashes;
  update both Claude SDK package dependencies with its native artifact version.
- Startup installs missing pinned runtimes, including first installs and upgrades,
  independently of provider enablement and without blocking app readiness.
- Keep complete archives under Home's `model-providers` directory. Hash all manifest
  fields for installation identity. Verify checksum, safe archive entries and exact
  CLI version before atomically publishing a completed directory. Never run npm or
  native updaters, resolve PATH/Desktop CLIs, or mutate auth/config directories.
- Scope owns one job per provider, cancellation and awaited temporary-file cleanup.
  Failed updates preserve old installations but never select an unpinned version.
- After setup, refresh only that provider and recheck auth. Credentials stay with
  the native CLI and inherited HOME/CODEX_HOME/CLAUDE_CONFIG_DIR. Never log tokens.
- RPC accepts provider/action only. Installation output is progress; only login
  accepts stdin. Setup state/output are bounded, ephemeral and never persisted.
