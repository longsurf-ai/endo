# claude-code

Owned Claude Agent SDK adapter. Product policy (tiers, permissions, tool
projection, installation) stays in the sibling `binding.ts` and the host.

The SDK owns the process, the protocol, and message routing, so this adapter
has fewer layers than Codex. One file per concern:

- `environment.ts`: the allowlisted subprocess environment; the SDK replaces
  the environment instead of merging it.
- `native-query.ts`: the `query()` bridge that lets the CLI resolve the
  permission mode (SDK issue #230). Remove when the SDK defaults to it.
- `history.ts`: prompt to appended system prompt, replayed transcript, and the
  final user message. OpenChart history is authoritative; fresh sessions
  receive the transcript as text because the SDK accepts only user input.
- `tools.ts`: OpenChart tools as one in-process MCP server. The CLI passes the
  model's tool use ID in `_meta`, so every exact outcome is keyed for the stream.
- `translate.ts`: SDK messages to AI SDK parts. Root text streams from partial
  events; subagent content arrives whole with `parent_tool_use_id`; the child
  is sealed when its Task result arrives, which the SDK orders last.
- `language-model.ts`, `provider.ts`: one query per call; append-only prompts
  `resume` only with unchanged tools and permissions, structured output uses `outputFormat`,
  abort uses `interrupt()`. Discovery and usage reads check `auth status --json`,
  then run one control request (`supportedModels()`, experimental `usage`) on a
  query that never sends a message.

Import only `@openchart/models/{provider-protocol,continuation,generate}` and
`@openchart/utils`. Never install, update, or log in. `strictMcpConfig` keeps
the operator's own MCP servers out of OpenChart runs.
