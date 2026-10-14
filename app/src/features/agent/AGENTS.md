# Agent feature

- Use `components/ui`; `app` owns routing/hosts.
- Consume Agent from `lib/agent`; AppLayout owns lifetime.
  Provider shares Agent through `useAgentContext`. Clients, Query invalidation,
  SessionStore, commands and observation hooks belong to that library.
  Submission requires a Session ID; Query retains model/draft.
  Optional viewContext is a captured string, appended as synthetic text
  after composer conversion, including for manual compaction.
  Visible foreground views acknowledge displayed ended Runs; hidden views do not.
  App selects Sessions before sending and owns navigation/dialogs.
- `components/agent-view/agent-view.tsx` composes conversations.
  Composer and Transcript share assistant-ui; AgentLayout arranges them. Hosts
  supply Session ID, submission callback, header, message actions, notices
  and new-chat prompt suggestions. Views derive status/failed input only from
  their Session's matching mutation.
- Key AgentView by Session ID. Restore model/workspace from latest User metadata;
  use defaults for empty conversations. Keep unsent choices local. Hosts supply
  transport; Workspace controls query `lib/workspace`. File suggestions/submission
  share workspaceId. Never add Session.model.
- `ag-ui/react/` adapts shared Session snapshots to assistant-ui presentation;
  assistant-ui owns draft/composer behavior. Never add a parallel transcript
  store, run state machine, protocol, or live-event replay buffer.
- Detaching views never cancels execution. Query owns finite reads and mutation status.
- Follow app/DESIGN.md. Preserve ChatGPT presentation, failed-submission drafts,
  visible permissions, and actionable query/command errors.
