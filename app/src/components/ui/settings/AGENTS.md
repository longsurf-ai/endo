# Settings presentation

Settings Card, CardItem and DropdownControl.

- Preserve the existing markup, component slots, geometry, and shared palette.
- No Config queries, transport, persistence, or independent state stores here.
- CardItem actions hold the actual control; htmlFor connects its title to that control.
- Route composition owns domain labels, descriptions, drafts, saves, and errors.
