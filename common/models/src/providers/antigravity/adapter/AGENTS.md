# antigravity

Owned adapter over the Antigravity CLI's headless mode. Product policy (tiers,
permissions, quota, sign-in, installation) stays in `binding.ts` and the host.

- `language-model.ts`: one `--input-format stream-json` process per call;
  append-only prompts `--conversation` resume only with unchanged tools,
  instructions and policy. Abort sends SIGINT.
- `history.ts`: input is text only; fresh conversations get the system
  instructions and replayed transcript as text.
- `translate.ts`: `step_update`/`result` events to AI SDK parts. Subagents run
  in the background and stay ordinary tool calls; usage sums the turn's steps.
- `host-tools.ts`, `native-config.ts`: OpenChart tools as one MCP server on a
  per-request loopback port. The CLI only reads MCP servers from its global
  config, so one fixed `openchart` bash relay plus two allow rules live there;
  the relay finds the request through environment variables and a token.
- `provider.ts`: `models` and `/usage` run with a closed stdin, so a signed-out
  CLI fails fast instead of starting sign-in.

Import only `@openchart/models/{provider-protocol,continuation,generate}` and
`@openchart/utils`. Never install, update, or sign in.
