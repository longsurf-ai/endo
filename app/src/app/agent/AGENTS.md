# Agent app composition

- `full-page-agent.tsx` binds AgentView to URL selection/navigation.
  Routes: `/app` starts a draft; `/app/sessions/:sessionId` selects.
  AgentProvider shares only Agent; AppRouteContext supplies transport.
  Key content by Session ID.
  Dig In and TaskCards mount shared AgentPanelContent beside the conversation;
  mobile covers the page; navigation clears it. Dig In creates on first send;
  TaskCards open existing Sessions.
- Layout owns sidebar navigation/closure and rename-dialog visibility.
  Callbacks use props; retries/shortcuts reuse Layout's New Chat.
- `lib/agent/use-agent.ts` owns queries, commands and mutation state.
  New Chat navigates to `/app`, preserving an existing unsent draft.
  First send creates/selects a Session; commands reject failures.
  Create/select missing Sessions before submission; retries use the URL ID.
  Query retains submission/model/failed input for the matching Session;
  assistant-ui owns editable drafts.
- Both hosts use shared `ResizableSidePanel` for desktop width and
  pointer/keyboard resizing; mobile remains full width.
- `copilot-agent.tsx` renders the selected Session and dropdown header; Layout
  owns selection/visibility and shares controls through CopilotControlsProvider.
  Creation controls append unsent text through assistant-ui in the current root
  conversation; reveal it without unmounting nested drafts. Consume requests once,
  retain existing text/attachments/quote, and focus the composer. Only Send admits work.
  Schedule opens existing Sessions through those controls for follow-up messages.
  Full-page routes hide it, preserving drafts and execution. Disable SessionPicker during creation/branching.
  AgentPanel owns nesting/Back; the app owns root selection/visibility.
