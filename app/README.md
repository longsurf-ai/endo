# Reagent app

The shared React app provides navigation and theme over the Reagent backend.
Chat uses assistant-ui for presentation; AG-UI owns the transcript
and runtime projection, and React Query owns the complete Session directory and
model list. See [DESIGN.md](DESIGN.md) for visual ownership.

## Local development

Use Node 24 LTS and install from the repository root:

```sh
just install
```

Start the Desktop application and its backend together:

```sh
just desktop
```

Desktop is the only application host. Debug and verify its UI through Computer
Use in the native app window. Vite provides renderer HMR inside Electron;
there is no standalone browser development entry or backend proxy.
The worktree-local development profile preserves settings, data and workspaces
across rebuilds.
Models come from the existing provider discovery and local authentication. An
empty model list disables sending; this app does not configure or fake providers.

Desktop starts the complete application server in a utility process and supplies
the required native operations. See the [desktop runtime](../docs/architecture/desktop.md).

## Application layout

Desktop mounts the App and router. AppLayout owns
LeftSidebar and SidebarInset/Outlet; the chat and Appearance routes fill the
content area without remounting navigation or the backend event connection.
Layout shares its existing Agent through AgentProvider. `useAgent` owns queries,
Session commands and submission status. FullPageAgent reads its Session ID from the
URL and navigates locally; Layout owns sidebar navigation and rename-dialog state.
AppRouteContext shares transport and required native host operations;
CopilotControlsProvider shares the layout-owned Copilot toggle.
Sidebar components receive callbacks through props.
Layout mounts Copilot beside the routed page and sidebar. It is available on every
page except full-page threads, preserving its Session and draft across navigation.
The shared PageHeader places sidebar and Copilot controls consistently.
LeftSidebar composes NavMain (New Chat, Schedule, Workspace, Settings) and NavChats. Unimplemented sections
have no placeholder links. MSW remains in tests only; Helmet and template landing
routes are removed from the product app.

## First version

- New chat, full conversation directory ordered by updatedAt, switching, rename.
- Branch a completed reply into a new chat with history through that reply.
- Model/variant selection, streamed replies, stop, Markdown/code/math/Mermaid/copy.
- Quote selected reply text through assistant-ui's toolbar and composer preview;
  persist it as a Quote ContextPart and render a QuoteBlock in user
  messages. Dig in remains a disabled placeholder.
- Native tool progress, subagent output, permission replies, errors and history.
- URL-based conversation restoration, rebootstrap after disconnect, and background
  execution that continues when switching away.
- Theme/fonts, floating/resizable sidebar, responsive drawer,
  keyboard navigation and light/dark/system preference.

Query receives Session metadata invalidation and Resource prefix invalidation
from the same SSE connection. No separate client stores, execution loop, API or data
model is introduced. Existing Feed hooks retain their contracts and lifetimes.

## Validation

Run `just check` from the repository root. App DOM tests, pure client/Feed tests, and real backend
HTTP/SSE integration checks cover their respective owners. Verify UI changes
through Computer Use in the running Desktop app.

The optional live suite uses the production frontend client against the isolated
Agent backend started with `just demo agent`. It creates test Sessions and exercises real providers,
permissions, cancellation, concurrent observers, and cold/live convergence:

```sh
npm --prefix app run test:agent:live -- http://127.0.0.1:43873
# Limit to a provider and a scenario name substring:
npm --prefix app run test:agent:live -- http://127.0.0.1:43873 codex concurrent
```

This suite requires authenticated local providers and is opt-in; it is not part
of CI. Agent UI components live in `src/features/agent/components`, with general
controls in `src/components/ui`.
