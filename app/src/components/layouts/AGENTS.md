# Shared layouts

- Own business-independent structure and layout interactions. Hosts supply
  content, visibility, focus behavior and responsive state.
- `ResizableSidePanel` owns its mounted width and left-edge pointer/keyboard
  resizing. Hidden panels keep children and width; mobile panels fill their host
  without a resize handle. Keep Session and routing state in app/feature owners.
- Follow [app design](../../../DESIGN.md) and use shared theme tokens.
