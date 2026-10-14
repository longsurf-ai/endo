# Model selector

- Keep the selector's interaction and visual structure. The trigger explicitly
  labels its combobox from the rendered value for assistive technology.
- This control owns presentation and transient popover/search state. It has no
  Agent, provider discovery, persistence, or runtime registration dependency.
- `features/agent/components/model-picker` maps the backend catalog and controls
  the selected value/effort. Empty strings keep both props controlled, including
  missing models and the provider's default effort.
