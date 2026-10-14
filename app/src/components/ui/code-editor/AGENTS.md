# Shared Monaco

- `lib/monaco/monaco.ts` owns the single bundled VS Code runtime, workers and
  workflow SDK typings; `grammars.ts` lists the TextMate grammars. Readiness waits for bundled theme and grammar registration
  before editors mount; Monarch grammars cannot supply highlighting in this runtime.
  Shared initialization failures are reported once by that runtime owner.
- This component owns readiness and common editor options. Overflow widgets
  (hover, suggest, parameter hints) render under `document.body`, so a
  transformed host such as a resizable panel cannot offset them.
  `code-editor.css` gives the hover the shared popover surface, in tokens, and a
  host's `kbd` hint a muted footer. `lib/theme` supplies
  the applied theme through `useDarkTheme`; hosts cannot override Monaco's global theme.
- Monaco React disposes instance models on unmount by default. Hosts using
  `keepCurrentModel` own retention and disposal.
- Workspace/LSP sessions and file persistence remain with the caller. Read-only
  viewers never fabricate Workspace identities or start language sessions.
