# Schedule composition

- `schedule-page.tsx` mounts Schedule at `/app/schedule` (list) or
  `/app/schedule/calendar`; the URL owns the view, the header Tabs navigate, and
  an unknown view redirects to the list.
- PageHeader keeps one fixed-height row across views and Copilot visibility.
  Tabs use its center slot; narrow headers collapse creation labels, not rows.
- `schedule-prompt-editor.tsx` fills the Schedule dialog's prompt-editor slot with
  `AgentPromptEditor`.
  Keep this layer stateless: Schedule owns Dialog/form/timing/persistence;
  Agent owns restoration, composer runtime and prompt choices. Features never
  import each other.
- Open occurrence Sessions in the shared Copilot. Editing never submits prompts,
  creates Sessions, or admits Runs.
- Creation menus use ScheduleView's opener or ScheduleCreateAction elsewhere;
  Agent creation prefills the current Copilot and preserves its unsent draft.
- Keep cross-feature integration tests here; schedule-only tests belong to the
  Schedule feature. See each feature's ownership guide.
