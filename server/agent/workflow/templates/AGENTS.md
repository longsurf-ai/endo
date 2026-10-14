# workflow programs

Each file is one trusted, self-contained workflow definition. Import only
`@openchart/workflow`, backed by the host authoring index;
Effect, Schema, prompt types, and
agent execution are available through that API. No backend services, sibling
modules, dynamic imports, or ambient I/O. Use `resource.get` for host-owned
execution-time reads; put writes and research in agents, and explicitly
pass returned answers into subsequent prompts.

Startup copies missing templates to the user's default Workspace under `workflows/`. Existing files stay authoritative and editable. Each `.workflow.ts` default-exports its definition; there is no executable catalog. Definitions own arguments and composition;
Session creation, persistence, permissions, concurrency bounds, and cancellation
belong to the runtime and host. `best-of-n.workflow.ts` demonstrates n independent
researchers followed by one summarizer, all as fresh Sessions under one root Run.
`multi-turn-debate.workflow.ts` runs a requested number of affirmative/negative rounds on any topic using two child Sessions,
continued via `agent(input, {sessionId})`, then summarizes the complete public
transcript in a fresh Session. All participants use `parentPrompt.model` unchanged;
each call has its own span.
