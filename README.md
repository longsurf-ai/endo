<p align="center">
  <img src="app/src/components/ui/brand/endo.png" alt="Endo logo" width="160" height="160" />
</p>

<h1 align="center">Endo</h1>

<p align="center">
  <img src="demo/media/readme-loop.gif" alt="Endo: choosing an agent, starting /best-of-n, and the workflow finishing with an answer in the thread" width="100%" />
</p>

<p align="center">
  <a href="https://downloads.longsurf.ai/endo/darwin/arm64/Endo.dmg">Download for Mac</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#key-features">Features</a> ·
  <a href="docs/development.md">Development guide</a>
</p>

<p align="center">
  <a href="https://github.com/longsurf-ai/endo/releases/latest"><img src="https://img.shields.io/github/v/release/longsurf-ai/endo?style=flat-square&amp;label=release" alt="Latest release"></a>
  <a href="https://downloads.longsurf.ai/endo/darwin/arm64/Endo.dmg"><img src="https://img.shields.io/badge/macOS-Apple%20Silicon-18181b?style=flat-square&amp;logo=apple&amp;logoColor=white" alt="macOS, Apple Silicon"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/longsurf-ai/endo?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/longsurf-ai/endo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/longsurf-ai/endo/ci.yml?branch=main&amp;style=flat-square&amp;label=build&amp;logo=github" alt="Build status on main"></a>
</p>

1. **Any agent, your subscription, one harness.**
2. **Meta harness, orchestrating any workflow.**
3. **A framework where humans and agents work together.**

Endo is an open-source desktop app and framework for building agentic
applications. It runs the agents you already pay for inside one harness, lets
you compose and schedule the work they do, and gives people and agents the same
typed data to work on.

## Quick start

[Download Endo for macOS (Apple Silicon)](https://downloads.longsurf.ai/endo/darwin/arm64/Endo.dmg),
open the disk image, and install Endo.

To run it from source, install [Node.js 24](https://nodejs.org/en/download),
[Bun 1.4.2](https://bun.sh/docs/installation), and [Just](https://just.systems/man/en/), then:

```sh
git clone https://github.com/longsurf-ai/endo.git
cd endo
just install --frozen-lockfile
just desktop
```

Sign in to at least one provider (an existing `codex`, `claude` or Antigravity
login works, or use Settings → Models), then ask something like "Every weekday
at 9 AM, summarize my priorities for the day" and open the Schedule page.

## Key features

### Any agent, your subscription, one harness

Endo drives Codex, Claude Code and Antigravity natively through their own
CLIs, signed in with the accounts you already have. There are no API keys to
paste: usage comes from your existing subscription, and Settings → Models shows
each provider's plan usage. The app installs and manages a pinned runtime
for every provider.

Every provider runs behind the same harness: one chat interface, one durable
history of Sessions and Runs, one tool registry, and one permission prompt
before a tool touches your data. Choose the model per chat; everything else
stays the same.

### Meta harness, orchestrating any workflow

Agents are building blocks, not the end product:

- **Workflows**: TypeScript `*.workflow.ts` programs that call agents, fan out
  sub-agent tasks and combine their results, with typings for authoring.
- **Slash commands** such as `/best-of-n`, `/multi-turn-debate`,
  `/thesis-killer` and `/hypothesis-race`, and `/compact` for long chats.
- **Sub-agent tasks**, and Dig In to branch a focused conversation from any
  message.
- **Schedules**: ask in chat ("every weekday at 9 AM, summarize my priorities")
  and the agent creates a schedule that runs the prompt later, on a cron or
  once. The Schedule page lists, edits and runs schedules and shows each run.

### A framework where humans and agents work together

- **Resources**: define a kind of user data once, as a Drizzle table and an
  Effect Schema, and get the typed API the app uses, the agent's
  `resource_read` / `resource_mutate` / `resource_search` tools, JSON Patch
  writes with revision checks, pagination, and live updates in every open
  window. People and agents change the same state under the same rules.
- **Permissions and questions**: the agent asks before it changes things and
  can ask you questions in the middle of a run.
- **Workspaces**: local folders you and the agent share, with a file browser
  and editors for code, Markdown, PDF, Office documents and images.

## Desktop releases

Endo packages as a standalone Mac app. Signed Apple Silicon releases download
updates in the background and offer a restart button in the sidebar. Unsaved
editors can cancel the restart; development builds never update automatically.

Maintainers can build a signed DMG and ZIP with `just desktop-release`, then
publish the verified downloads and update feed with `just desktop-publish <version>`.
See the [release guide](docs/operations/desktop-release.md) for signing setup,
installation checks, and hosting. Creating or merging a PR does not publish a download.

## Building on it

- Add user data as a Resource: [Adding a Resource](docs/architecture/resource.md#adding-a-resource).
- Add an agent tool in `server/agent/tool/tools/` and register it in
  `server/agent/tool/registry.ts` and `server/agent/profiles/builtin.ts`.
- Change the agent's instructions in `server/agent/profiles/prompt/segments/`.
- Add a page under `app/src/app/` and a feature under `app/src/features/`.

See the [development guide](docs/development.md) and the
[code organization guide](docs/architecture/code-organization.md). Endo is at
0.1.x, so expect breaking changes.

## Staying updated

[Star Endo](https://github.com/longsurf-ai/endo) to follow releases and help more
people discover it.

## License

[MIT](LICENSE)

## Credits

Endo began as the core of [OpenChart](https://github.com/longsurf-ai/openchart).
It credits [Jan](https://www.jan.ai/) for the app's design and visual style,
[OpenCode](https://opencode.ai/) and [Effect](https://effect.website/),
[assistant-ui](https://www.assistant-ui.com/) and [AG-UI](https://docs.ag-ui.com/introduction),
and [shadcn/ui](https://ui.shadcn.com/docs), [Radix UI](https://www.radix-ui.com/primitives),
and [Base UI](https://base-ui.com/).
