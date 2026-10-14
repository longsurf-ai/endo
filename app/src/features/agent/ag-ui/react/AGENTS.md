# React agent adapters

- AG-UI owns event reduction; these hooks adapt the shared session to React and assistant-ui. Never add transcript or execution state here.
- `lib/agent/use-session-snapshot.ts` subscribes to the shared session handle.
- `lib/prompt-converter/converter.ts` owns the composer draft type and conversion to prompt Parts; runtime hooks consume that contract.
- `use-assistant-ui-runtime.ts` maps commands and loading/run state for an explicit Session; the host supplies submission state. The adapter identifies the current thread by Session ID. Failed input for that Session restores an empty composer after creation. A missing model disables composition, never history viewing.
- Editing uses upstream `onEdit` and the message composer. Resolve the preceding reply's canonical ID, truncate only on confirmation, then call the same host submission. Reopen the edit on truncation failure; submission failures restore the ordinary composer through Query's failed draft.
- `assistant-ui-messages.ts` groups tool Activity/subagents before metadata. `assistant-ui-message-metadata.ts` owns timestamps and `finalReplyStartIndex`; actions and transcript layout consume that one selection. Select replies before cloning. `assistant-ui-user-parts.ts` restores workflow, quote/Dig In data Parts and attachments from `metadata.parts`; native user content is bubble text only, never parsed for structure.
- Presentation belongs in `features/agent/components`; converter tests belong in `__tests__`.
