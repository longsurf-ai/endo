# Shared Agent input constraints

- `prompt-constraint.ts` owns the composer-restorable Part subset, ordering,
  and leading command recognition. Backend saved targets and frontend restoration
  use the same constraint. Empty Parts are valid drafts; admission owns nonempty input.
- `directive-formatter.ts` owns pure chip syntax shared by constraint checks,
  composer, and transcript. Keep escaping and ordinary text lossless.
- No app, server, platform, React, or execution dependencies. Complete
  AgentPromptInput, command registry validation, and execution remain server-owned.
- Changes must preserve the frontend's draft/Parts round-trip tests and backend
  Resource rejection feedback.
