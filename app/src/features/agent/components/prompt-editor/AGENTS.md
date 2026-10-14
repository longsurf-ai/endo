# Saved prompt editor

- Own prompt restoration, standalone composer drafts and model/workspace choices.
  Agent APIs restore Parts; the shared converter owns round trips. Unsupported
  Parts show retry/cancel, never an editable partial prompt.
- assistant-ui owns text, quote and attachment drafts. Initialize once per mount;
  unmount discards edits. Reading completes images and converts Parts without
  trimming, clearing or submitting. Unchanged Parts are reused intact.
- Reuse AgentComposer and ComposerControls. Initialize from the saved prompt or
  Agent defaults; use the selected workspace for file suggestions. Loading defaults
  is initialization, not an edit. Compare explicit selections with the saved prompt
  or new-prompt defaults. Dirty state is independent of validity.
- The host owns persistence, pending state and closing. Never import Schedule,
  create a Session or admit a Run. Mount anew for a different snapshot.
- Restoration status stays in the composer slot with `ready: false`; keep the
  host form available. Unsupported Parts remain intact and are never partially edited.
- Expose the current model and Parts/model/workspace change flags for independent
  saved actions. Empty prompts remain empty Parts. Hiding retains drafts; only
  enabled Agent actions require readiness.
