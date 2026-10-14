# app

Desktop application UI without Electron imports. See [DESIGN.md](DESIGN.md).

Choose code placement by responsibility, not size or reuse count.

| Location                     | Use when the code…                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `features/<name>/api`        | Owns feature requests and cache coordination, including query/mutation hooks.                           |
| `features/<name>/hooks`      | Coordinates feature-specific state and behavior beyond API access.                                      |
| `features/<name>/components` | Renders feature-specific UI, including its layouts and interactions.                                    |
| `app`                        | Composes features, routes, navigation, or shell lifecycle; composition hooks stay with their app owner. |
| `hooks`                      | Provides reusable React behavior without feature or app dependencies.                                   |
| `lib`                        | Provides shared infrastructure and technical integrations across features.                              |
| `components/ui`              | Provides general controls or visual primitives without business knowledge.                              |
| `components/layouts`         | Provides reusable page structure without feature or app dependencies.                                   |

Component placement decision tree (evaluate from top to bottom):

```text
What does this component own?
|
├─ App routes, navigation, cross-feature composition, or feature placement?
│  └─ app/
│     Examples: FullPageAgent, AgentSidebar, application sidebar
|
├─ Feature-specific concepts, state, or behavior?
│  └─ features/<name>/components/
│     Examples: Composer, Transcript, ModelPicker, AgentLayout
|
├─ Business-independent page structure, arrangement, or scrolling?
│  └─ components/layouts/
│     Example: a layout with header, body, and footer slots
|
└─ General controls or visual primitives?
   └─ components/ui/
      Examples: Button, Input, Dialog, Dropdown
```

Feature-specific layout rules belong to the feature even when reused across pages
and sidebars. Keep component-private helpers in the same file; extract neighboring
files for independent responsibilities.

Component-private hooks stay beside their component. Features never import each other; `app` connects them.

- Runtime imports use common packages, never server/platform implementations.
  The server edge is types-only AppRouter in shared transport. No Effect runtime
  in components; Schema exceptions require an explicit owner rule and boundary check.
- Desktop injects the required AppHost through bootstrap.
  App shares native operations through AppHostProvider; consumers use useAppHost.
  Use `just desktop` and Computer Use for UI debugging; there is no browser entry.
  MSW is test-only.
- `lib/transport/transport.ts` owns the backend connection (origin, optional token), tRPC
  and SSE. Tokens never reach storage or logs. Features consume clients/hooks.
  Query owns directories/models/finite reads.
- Features: `agent` (chat), `schedule` (Schedule/Occurrence UI) and `workspace`
  (file browser and editors). `app/` composes them with the sidebar and routes.
- App and Storybook share `styles/globals.css` and ThemeProvider.
  CSS owns visuals; Config owns preferences; ThemeProvider applies them. Shared
  styles never import features or composition.
- Reuse shared form controls at their component owners, one directory per
  component. Keep the existing shared Dialog and bundled fonts.
  Existing shell surfaces retain their documented design. Keep icons and brand marks.
- New tests belong in the owning module's `__tests__/` directory.
- Use OpenChart's shared ESLint configuration; import and Tailwind resolution are cwd-independent.
  Only authored CSS authorizes utilities. Preserve editor/CLI parity tests in
  [tooling](tooling/AGENTS.md), including config reload when upgrading dependencies.
- Run `npm run check` on the workspace compiler baseline; verify sidebar
  interactions when changing jsdom dependencies.
