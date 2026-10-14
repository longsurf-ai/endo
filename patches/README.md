# Dependency patches

Install from the repository root with `bun install --frozen-lockfile`. The workspace manifest
and lockfile pin these patches; no manual node_modules changes are required.

## Tool result failures

Why: in 0.0.59, `ToolMessage.error` exists but `TOOL_CALL_RESULT` has no declared
`error` field, and the client reducer drops it when constructing the tool message.
Streamed tool failures therefore lose their failure status before rendering.

`@ag-ui/core@0.0.59` and `@ag-ui/client@0.0.59` apply the runtime and type changes
from [AG-UI PR #2549](https://github.com/ag-ui-protocol/ag-ui/pull/2549), pinned
to commit `b10a8315f46907d478d018ed959707e2597b3791`.
The upstream preview artifacts were compared with 0.0.59: the source changes
are confined to `src/events.ts` and `src/apply/default.ts`.
The community proposal adds the event field and reducer propagation together;
PR #2549 was still open when checked on 2026-09-10.

- The native `TOOL_CALL_RESULT` schema accepts optional string `error`.
- The client reducer copies it to `ToolMessage.error`. An empty string still
  denotes failure; omission denotes no reported failure.
- Both ESM/CommonJS outputs and the core declarations are patched. The client's
  declarations already reference core types and need no change. Other behavior
  and the package versions stay unchanged.

TODO(remove): after upgrading both packages to releases containing the schema
and reducer fix, delete both patch files and their `patchedDependencies` entries
in `package.json`, remove the matching `_comment_patchedDependencies` note,
and regenerate `bun.lock`. A merged PR alone is not enough: the installed
releases must preserve `error`, including an empty string, without patches.
`app/src/features/agent/ag-ui/react/__tests__/assistant-ui-messages.test.ts` covers schema validation and failure rendering;
`server/agent/publisher/agui/projection.test.ts` exercises native reducer replay without
transcript snapshots.

## Ordinary Activity conversion

`@assistant-ui/react-ag-ui@0.0.58` currently discards non-A2UI Activity messages.
The local patch preserves them as assistant-ui data parts with their original
activity type, content, ID and AG-UI metadata. A2UI handling stays unchanged.
This fixes conversion, not the AG-UI reducer, which already supports native
ACTIVITY_SNAPSHOT and ACTIVITY_DELTA.

Related community solution:
[assistant-ui issue #5348](https://github.com/assistant-ui/assistant-ui/issues/5348)
and [PR #5352](https://github.com/assistant-ui/assistant-ui/pull/5352) restore
Activity messages as renderable parts, but only for `a2ui-surface`; the merged
implementation explicitly continues dropping other activity types. The generic
Activity-to-data conversion here remains a local proposal; no equivalent upstream
issue or PR was identified when checked on 2026-09-10.

Application code in `app/src/features/agent/ag-ui/react/assistant-ui-messages.ts` associates `openchart.tool` activities
with tool cards. The library patch contains no OpenChart-specific mapping.
TODO(remove): when an installed release provides equivalent ordinary Activity
preservation (type, content, ID and metadata), delete this patch file and its
`patchedDependencies` entry in `package.json`, remove the matching
`_comment_patchedDependencies` note, and regenerate `bun.lock`. A2UI-only
support does not satisfy this condition. Keep the converter regression tests
during the upgrade.

## Questionnaire on React 18

`@shadcn/react@0.3.1` declares React 19 peers; the Questionnaire hooks are available
in React 18, which this app uses. The local patch wraps Root, Item, and Input in
`forwardRef` and uses the empty-string form of `inert` that React 18 preserves.
It keeps a lone ref unchanged when merging props, so a render does not detach and
reattach a state-setting ref. Item registration updates in place when its visible
fields have not changed, and its cleanup runs when the Item unmounts. Otherwise
the live browser can repeatedly unregister and re-register an Item until React
throws `Maximum update depth exceeded`.
It does not change selection, navigation, validation, or submission behavior.
Only the Questionnaire entry point is used. Component tests exercise the real
package on React 18, including refs, inactive controls, choice/text answers, and retry.

Upstream: https://github.com/shadcn-ui/ui/tree/main/packages/shadcn
Remove this patch after the app upgrades to React 19 or the package supports
React 18; retain the Questionnaire integration tests and regenerate `bun.lock`.
