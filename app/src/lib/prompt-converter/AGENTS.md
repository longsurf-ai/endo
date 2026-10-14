# Agent input conversion

- `converter.ts` owns `ComposerDraft`, transport-derived `PromptParts`,
  `toPromptParts`, and `fromPromptParts`. It never submits or mutates input.
- Inject command construction/restoration; command definitions remain server-owned.
  `directive-formatter.ts` shares chip syntax with composer and transcript.
- Session, model, workspace, request identity, and submission retain their owners.
- Shared Part constraints and chip syntax live in `@openchart/agent`; keep
  validation there so backend saved targets enforce the same rules.

<!-- HUMAN-ANNOTATION:START -->

Only composer output is supported: optional quote, text (including file-reference
chips) or one registered leading command, then completed image attachments.

`toPromptParts` and `fromPromptParts` must round-trip:

- Draft → Parts → draft preserves prompt meaning.
- Composer Parts → draft → Parts preserves all fields and order exactly.

Only editor identity (`quote.messageId`, attachment IDs, original browser `File`)
and command spelling/formatting may change. Keep ordinary text verbatim.

Reject unsupported Parts or fields; never silently drop, merge, reorder, or
stringify them. New composer output or commands need an inverse and round-trip
tests before shipping.

<!-- HUMAN-ANNOTATION:END -->
