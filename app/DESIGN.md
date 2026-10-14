# Reagent design

## Foundation

Build on existing libraries and shared components:

- The shell keeps one visual language across navigation, surfaces, spacing,
  Inter typography, settings Card/CardItem and Sonner.
- Shared buttons, forms and general controls live in `components/ui`, including
  the event calendar. Keep one shared Button and the existing Dialog; do not fork
  them per feature.
- **assistant-ui** drives conversation presentation. Keep the app's theme, fonts
  and host layout.

Keep shared components' structure, styling and interaction details intact. Do not
import third-party stores or backend lifecycle. General controls live individually
under `components/ui`; placement follows [AGENTS.md](AGENTS.md).

## Style ownership

- **CSS owns visual values.** [globals.css](src/styles/globals.css) is the shared
  App/Storybook entry; [themes.css](src/styles/themes.css) owns colors and semantic
  tokens; `fonts.css` owns bundled fonts. Tailwind maps these tokens, including
  complete CSS colors through `color-mix`. Do not duplicate palettes in JavaScript
  or create separate feature themes.
- **Keep the established foundation.** Gray light/dark surfaces distinguish
  sidebar and canvas; primary actions use the Neutral palette. Retain the 16px base,
  14px body, 10px base radius and 8px scrollbars. Shared buttons and header controls
  use `rounded-md`; keep the existing shapes in conversation components.
- **Style at the owner.** Reuse shared primitives and variants; use Tailwind for
  layout and visual values. Local CSS is for third-party overrides, generated
  content and effects utilities cannot express; repeated selectors may use
  `@apply`. Shared styles contain no feature-specific selectors.
- **One applied theme.** Config owns the preference, defaulting to system;
  [ThemeProvider](src/lib/theme/theme.tsx) applies it. App, portals, charts and Monaco
  follow that theme; imperative adapters use `useDarkTheme`. Light/dark and nested
  scopes resolve the same token roles. Opt-in forms and their portals use
  `neutral-controls.css`, inheriting the global primary pair.
- **Isolate page layers.** The HTML app root uses `isolate` so body portals sit
  above page content, following [Base UI's portal setup](https://base-ui.com/react/overview/quick-start#portals).
  Keep page-local layers inside that root; avoid per-popup z-index fixes for page overlap.

## Essential interaction rules

- Reuse shared page frames, SidebarProvider and ResizableSidePanel. Their owners
  manage scrolling, collapse and resize state; consumers do not mirror it.
  Preserve drafts and panel width when hiding Copilot.
- Use shared Tooltips for icon actions, visible keyboard focus and
  touch-accessible controls. Preserve brand glyphs and honor reduced motion.
- Agent surfaces share the same components. Keep final answers outside collapsed
  work; failed or unfinished work stays expanded. Preserve the composer's footer
  fade and inline model/workspace controls.
- Workspace keeps compact 24px tree rows, aligned icons and full-path tooltips.
  Built-in sources remain read-only; editors follow the app theme and retain drafts.
- Report operational failures once through the shared Sonner/Query error handling;
  non-Query observations use `useErrorToast`. Toasts sit 8px below the 60px headers
  with Sonner's default duration and no close button; titles are short phrases
  without a trailing period. Reads offer Retry; failed writes keep their UI and
  draft without automatic replay. Keep validation and saved execution failures in
  context, without duplicating operational error messages inline.

Keep feature-specific geometry and behavior in their owning guides and components.
This file records shared design rules, not a feature inventory or change log.
