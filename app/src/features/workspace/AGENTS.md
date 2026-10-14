# Workspace files

- `workspace-view.tsx` composes the shared Sidebar (switcher and Add above, search
  below) and one Dockview group; only widgets are `collapsible`. One Workspace
  shows at a time; `stores/view.ts` remembers it per placement.
- Dockview owns tabs and activation; identity is `{workspaceId, path}` in params
  and IDs. `openWorkspaceFile` serves tree and language jumps. Entries under dirty
  tabs never move; removal reads live dirty/saving flags.
- Toolbars: breadcrumb, `ToolbarControls` view switches, then `file-actions.tsx`.
  Editors register `save` in `saves` by panel id.
- `viewers.ts` maps MIME, then path, to one viewer: text edits; other bytes show
  read-only in `FilePreview` (shared with Quick Look) or open externally.
- Reads supply `readOnly`: built-ins never draft or save. Panels own drafts and
  original hashes; refresh keeps dirty text; hash differences show the conflict
  banner. AI merge preserves the draft before clearing it. Saves use CAS.
- Editor models use `inmemory:` URIs; Monaco infers languages from the path.
  Active files reach `useAssistantContext`.
- Query/SSE owns metadata; disk owns files. Clean up Blob URLs. Widgets open,
  reveal, then clear their placement's file request.
