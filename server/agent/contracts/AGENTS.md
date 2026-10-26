# agent contracts

Owns pure Session, Message, Part, SessionAnchor, AgentPromptInput, and
AgentPromptTarget schemas.
Sibling Agent modules own persistence and execution.

- Import only Effect schema primitives, shared Agent constraints, identifiers/model-tier constants,
  and local contracts. No services, provider adapters, database, or dynamic loading.
- `part.ts` alone aggregates Parts. External consumers use top-level
  contracts; [parts](parts/AGENTS.md) owns concrete variants.
- Session uses flat fields and epoch-millisecond timestamps. `kind` is required;
  ordinary conversations use `chat`. Only absent relationships/lifecycle facts are null.
  It has no user identity, permission policy, transcript collection, or execution
  state. Messages own Session references; Parts reference only Messages.
- Parent Sessions own dig-in anchors: source Part, selected text/range, child
  Session are required. Selection text is a snapshot.
  Bindings use `createdAt DESC, id DESC`, without another generation counter.
- Dig-in display begins at its sole user-message marker; earlier history remains
  model context. Branch writers reject Dig In sources and copied Dig In markers.
- Prompt input derives from Parts; Session/Message/Run/intent identities stay
  outside the immutable prompt value.
- Prompt models require a supported provider and a nonempty tier alias or native
  identity. Execution validates availability; only tier aliases may fall back.
- Use native Schema.Json/JsonObject and codecs; each schema owns mutability,
  unknown-key policy, and JSON encoding. Derive types instead of parallel shapes.
- SQL payload projections belong in server Session storage and derive from these
  contracts. Tests here remain pure; server integration tests stay server-owned.
