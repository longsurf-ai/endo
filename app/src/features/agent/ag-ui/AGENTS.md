# AG-UI adapters

- `lib/agent` owns the client, SessionStore, Query coordination and React
  observation hooks. AG-UI owns message/state reduction there; views never add
  a transcript reducer, execution state machine or directory store.
- `react/` owns assistant-ui message projection and conversation runtime adapters.
  They consume shared Session handles without owning the underlying observation
  lifecycle. Detaching a view never cancels backend execution.
