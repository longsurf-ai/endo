# Agent API

- Shared client, directory/model queries, commands and cache invalidation belong
  to `lib/agent`. This directory owns APIs specific to the chat editor.
- `prompt-draft.ts` restores and compiles saved prompt Parts for the editor;
  conversion and command calls stay outside presentation and never submit a prompt.
- Tests belong in `__tests__/`.
