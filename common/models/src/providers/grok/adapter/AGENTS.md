# grok

Owned adapter over the Grok CLI's ACP agent mode (`grok agent --no-leader
stdio`). Product policy (tiers, permissions, quota, sign-in, installation,
environment) stays in `binding.ts` and the host.

- `acp.ts`: one agent process and its JSON-RPC traffic; exit fails every wait.
- `language-model.ts`: one process and prompt turn per call. Append-only
  prompts `session/resume` only with unchanged tools, instructions and policy;
  approvals and questions reach the host through request callbacks; abort
  sends `session/cancel`. Structured output uses `_meta.outputSchema`.
- `history.ts`: fresh sessions get system instructions as rules and the
  transcript as text; an empty first block keeps a leading `/` literal.
- `translate.ts`: root and child sessions to AI SDK parts. Foreground
  `spawn_subagent` calls become delegates bound by `subagent_spawned`;
  `search_tool` and OpenChart `use_tool` steps stay hidden.
- `host-tools.ts`: OpenChart tools as a per-request loopback HTTP MCP server
  with a bearer token, passed in `mcpServers`; no Grok config is written.
- `provider.ts`: discovery and plan usage use `_x.ai` extension requests on an
  agent that never creates a session.

Import only `@openchart/models/{provider-protocol,continuation,generate}` and
`@openchart/utils`. Never install, update, or sign in.
