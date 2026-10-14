# codex

Owned Codex app-server adapter. Product policy (tiers, permissions, tool
projection, installation) stays in the sibling `binding.ts` and the host.

One file per layer; dependencies point downward:

- `protocol.ts`: the wire subset we read, parsed once with loose Zod objects.
  Source of truth is `codex app-server generate-json-schema` for the pinned CLI.
- `rpc.ts`: one process, newline-delimited JSON-RPC, lazy start. A crash rejects
  in-flight requests and notifies exit listeners; the next request respawns.
- `threads.ts`: routes thread-scoped notifications and requests to the owning
  request. `thread/started.parentThreadId` binds subagent threads. Unknown
  threads fail closed.
- `history.ts`: prompt to developer instructions, injected Responses items, and
  turn input. OpenChart history is authoritative; `thread/inject_items` carries it.
- Shared `continuation.ts`: reuses a thread only for an append-only prompt with
  the same tools and permissions. Policy changes discard prior grants.
- `media.ts`: MCP images and `codex/toolSurface` screenshots to the shared envelope.
- `translate.ts`: notifications to AI SDK parts. A child's finish precedes its
  proxy result; parent output is never held back; root completion seals children.
- `language-model.ts`, `provider.ts`: one turn per call. OpenChart tools run
  in-process through `dynamicTools` and `item/tool/call`; the exact outcome is
  the tool result.

Import only `@openchart/models/provider-protocol` and `@openchart/utils`. Never
install, update, or log in. `dynamicTools` is gated by `experimentalApi`; verify
it on every CLI upgrade.
