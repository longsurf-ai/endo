# Schedule

- Own paginated Schedule/Occurrence queries, the collapsible list and the one open
  draft; derive Resource RPC types. The app supplies `view` (list or calendar).
- One controlled Dialog owns creation/editing forms and timing. ScheduleView captures
  the draft's revision and passes `stale` once the list moves on;
  cancel discards edits, failures retain them, and remote changes require reopening.
  Patch only changed name, recurrence and injected prompt-editor output (Parts/model/workspace).
  Preserve agent, binding, enabled, nextFireAt, unrecognized cron and unchanged timestamps.
  Creation control slots use that same draft. ScheduleCreateAction hosts the same
  form for standalone entry points; it owns only the new draft's open state.
- Toggles patch only `enabled` at the displayed revision. Query owns pending/errors
  and refresh after success/conflict. Shared Resource invalidation handles Agent
  changes and reconnects.
- Confirm deletion in Dialog; Resource delete removes Schedule
  and occurrences, retaining Runs/Sessions. Query clears history and refreshes the list.
- Run now uses Scheduler even when disabled; refresh history and open the Session.
  Never patch cursors or execute prompts here.
  Pending admission disables Play; no automatic retry.
- `schedule-calendar.tsx` projects enabled schedules onto the shared `event-calendar`,
  read-only: every fire in range via croner with the Scheduler's options, none before
  `createdAt`, touching fires merged into one block, never sampled. Events open the
  Dialog; empty slots start a one-time draft, drawn as a placeholder event while its
  dialog is open. The shared header always exposes creation in both views,
  including empty/loading states. Week/day only: per-minute stepping would stall on a dense month.
- Collapsible owns expansion and lazy history mounting. Preserve backend cursor
  order; filter every history page by `scheduleId`.
- Occurrences prove admission, not execution success; Run supplies `sessionId`.
  One-time cursors do not guarantee future runs.
- `app/schedule` supplies the prompt-editor slot and opens Sessions in editable
  Copilot. Never import Agent or own its composer runtime. Reuse shared UI controls.
  Creation writes the Resource; never create Sessions, Runs or timers.
