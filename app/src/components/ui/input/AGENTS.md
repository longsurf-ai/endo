# input

Plain input appearance shared by forms and the sidebar.

## Invariants

- This primitive owns input styling through OpenChart tokens and forwards native
  props and the DOM ref. It does not require form registration or render labels.
- `../form/input.tsx` composes this primitive with labels, errors, and registration;
  do not duplicate input styling in that wrapper.
