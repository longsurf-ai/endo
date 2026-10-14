# theme-switcher

## Invariants

- The control receives theme, onChange, and disabled; Settings owns the Config mutation.
- No local theme store, storage access, system-mode listener, or palette values.
- The control is feature-independent and can be placed in any application shell.
