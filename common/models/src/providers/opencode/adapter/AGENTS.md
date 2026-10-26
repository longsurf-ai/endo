# OpenCode adapter

Owns OpenCode V2 ACP over one private subprocess per request; never import sibling
adapters or product policy. The host supplies the managed executable.

- Pin behavior to the onboarding manifest. ACP `session/resume` returns config
  options without a session ID; only pre-prompt resume failures may start fresh.
- Discovery uses an explicit stable directory and disposable native session.
  Native model config options establish availability and efforts; catalog data
  never introduces models. Workspace config is checked again during execution.
- Endo history is authoritative. Native IDs are private bounded continuation
  hints; include model, cwd, effort, instructions, permissions and tool schemas.
- Request-only agents carry instructions and primary/small-model selection.
  Preserve native provider policies; escape config substitution tokens in generated
  instructions. Never write native configuration or credentials.
- Host tools use an authenticated loopback MCP server with a unique namespace.
  `ai.opencode/sessionID` routes outcomes; emit the exact host result, not the
  native codemode proxy's projection.
- Advertise the child-session extension and translate its lifecycle separately.
  Parent usage excludes children. Never reconstruct child text from proxy results.
- Structured output uses one schema-validated MCP submission. Missing/invalid
  output fails without automatic replay. Cancel aborts callbacks and awaits cleanup.
