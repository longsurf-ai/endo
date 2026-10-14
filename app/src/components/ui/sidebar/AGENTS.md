# sidebar

Responsive Radix sidebar with the shell's visual geometry and gradient.

- SidebarProvider owns desktop collapse, mobile drawer, and resize width. Layouts
  consume this state and never mirror it in another store.
- Default width is 15rem; pointer dragging clamps between 14rem and 20rem and
  collapses below 7rem. Pointer capture owns the gesture through release/cancel.
- Desktop transitions remain 200ms linear and are disabled during resizing.
  Mobile uses the existing Drawer and 768px breakpoint. Reduced motion wins.
- The sidebar-to-background gradient consumes shared theme tokens; dimensions
  remain component-local. The floating variant leaves its right edge unpadded.
- Navigation, menus, routes, permissions, and logout belong to the consuming layout.
- Keep the composable exports together. SidebarInput uses the plain Input.
- The existing cookie records desktop collapse changes; restoration is caller-owned.
  Drag width is local UI state and resets to its default on reload.

- `embedded` uses the canvas background, sizes the sidebar to its container,
  uses a 640px compact overlay, and leaves the application cookie unchanged. Cmd+B targets the nearest
  provider of the focused element; the application sidebar stays independent.
