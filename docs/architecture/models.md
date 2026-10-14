# Model layer

`common/models` owns the model catalog, native provider bindings, AI SDK
provider adapters, request transforms, MCP execution outcomes, and normalized
delegate stream protocol. It is a Node package with no dependency on V1,
server, or Effect.

[`provider-protocol.ts`](../../common/models/src/provider-protocol.ts) owns the
Zod schemas and derived types for OpenChart metadata, delegate lifecycle payloads,
and native tool results. [`stream.ts`](../../common/models/src/stream.ts) validates
these once after the SDK, consumes the transport-only media marker, and wraps all
native results in one `ProviderNativeToolOutput` envelope. `ModelStreamEvent`
correlates result provenance/payload types. Application outcomes remain host-owned and opaque to
models. Consumers use the validated types without reparsing provider data.
[`protocol.md`](../../common/models/src/protocol.md) illustrates lifecycle ordering.

Generic assertion, error, lazy-value, and function helpers live in
`common/utils` (`@openchart/utils`). Models imports them through that shared
package; utilities never depend on models or application layers.

Architecture tests enforce package and adapter boundaries. Protocol schemas and
conformance tests enforce the evolving contract. All CLI adapters accept complete input history
on every call and keep native continuation private: model handles and callers
expose no cache/session API, no transcript or tool closure is stored, and
provider disposal clears the hints.

All adapters share `providers/continuation.ts`: a bounded map from the SHA-256 of the
prompt that completed a turn, plus the tool set, to the native ID (a Codex
thread, a Claude session, an Antigravity conversation). A hit requires the new prompt to be exactly that
prompt followed by one assistant segment and one new user message; the native
conversation then receives only the new message. Hits are consumed exclusively,
so concurrent branches cannot mutate one native conversation. Claude checks
native session metadata before committing input to a remembered session; a
failure after the turn starts is propagated without automatic replay.

Anything else starts fresh. Codex injects the prior history as Responses API
items through `thread/inject_items`, so edits, forks, provider switches and
compaction keep tool-call fidelity. Claude's SDK and the Antigravity CLI accept
only user input, so a fresh session receives the transcript as text in its first
user message.
Local continuation hints do not guarantee provider-side KV cache retention.

If host execution appends Assistant/tool messages after the latest User (for
example, a deterministic workflow), all adapters start fresh and replay the
entire prompt, then send a neutral continuation cue. They neither resend the
original user request after its result nor drop the trailing work. These calls
do not retain continuation hints under an incomplete user prefix. Claude's text
replay preserves complete tool arguments and results; context reduction belongs
to the application, not a silent per-value adapter truncation.

`providers/<id>/adapter/` (`claude-code`, `codex`, `antigravity`) each own their
native protocol, request execution, tool transport, and stream translation. No
adapter imports another; each imports only the shared protocol schema
(`provider-protocol.ts`), `providers/continuation.ts`, `providers/generate.ts`, and
`@openchart/utils`. OpenChart policy and tool outcome projection live in each
`providers/<id>/binding.ts`, exported as one `NativeProvider` object (`native-provider.ts`).
`providers/index.ts` is the only module that lists them; root `common/models`
modules take a `NativeProvider` as a parameter and never import it. The shared
processor-facing contract remains authoritative: each adapter emits its metadata
and scoped markers, and the canonical consumer validates those outputs. The
architecture test enforces these import boundaries.

OpenChart tools run inside the native loop but in OpenChart's process:
`provider-tools.ts` defines the contract, Codex declares them as native dynamic
tools, and Claude registers them on the SDK's in-process MCP server. Each
adapter emits the exact outcome as the tool result, marked
`toolExecution: "provider-mcp"`; no middleware restores anything afterwards.
Claude raises the CLI's MCP client deadline to two hours through
`MCP_TOOL_TIMEOUT` and Antigravity through its relay entry's `timeoutSeconds`;
Codex dynamic tools have no server-side deadline. OpenChart
owns timeout policy and cancellation for its own tools.

Working public capabilities, including active-call controls, callbacks, images,
tools, and structured output, remain available. The public stateless contract
is preserved; native continuation is an optional internal optimization.

Claude uses one SDK query per call. Root text and thinking stream from partial
messages; subagent content arrives as complete messages carrying
`parent_tool_use_id`, which owns delegate ancestry. The SDK emits every child
message before the Task result, so the adapter seals a child exactly when its
proxy result arrives. Buffered generation replays the same stream through the
shared `providers/generate.ts`.
Codex uses one lazy app-server process per provider and one thread turn per
call. Each call owns its thread routing, OpenChart tools (declared as native
`dynamicTools` and answered in-process on `item/tool/call`, keeping the exact
outcome for the stream), approvals, and cleanup. There is no steering. Known
notifications are parsed once at the RPC boundary and keep their schema-derived
types through stream translation.

Codex reasoning `item/started` emits `reasoning-start` before any summary or
text delta arrives. Later deltas reuse that start, and item or turn completion
closes it even when no text was returned. The adapter preserves delegate scope
and parent/child ordering for starts just as it does for deltas; consumers do
not need provider-specific lifecycle handling.

Codex starts threads with native history persistence enabled because
history-forked subagents require the parent's saved rollout; a remembered thread
stays loaded for its next turn. Claude persists every session and resumes a
remembered one in a new query. Provider disposal clears hints, closes the Codex
process and interrupts active Claude queries; native transcript files remain on disk.

Codex `userMessage` items acknowledge replayed input and remain raw events;
they never become assistant tool calls. Native `subAgentActivity` starts bind
the descendant thread to the same delegate lifecycle as collaboration starts,
so child content, MCP calls, and nested descendants retain their own scope.
These activity notifications omit the original delegated prompt; its normalized
value remains empty rather than being inferred from child output.
Activity item IDs identify individual notifications; only `started` creates a
delegate. Terminal activities resolve an existing proxy by `agentThreadId`, whose
binding lasts until the root turn ends. `interacted` becomes an ordinary
`agent_interaction` tool call in the sender's scope: its target may be a parent
or sibling. The native activity does not distinguish `send_message` from
`followup_task` or include their message body.

Claude Code permission requests omit absent optional SDK hints from metadata.
This keeps native tool approval requests valid at the application's JSON boundary.

Each adapter's test file drives it through the real AI SDK stream and canonical
conformer against a scripted native source: Codex's `codex.test.ts` uses an
in-memory app-server, Claude's `claude-code.test.ts` a scripted SDK query, and
Antigravity's `antigravity.test.ts` a scripted fake CLI that reaches host tools
through the real relay. They cover text and reasoning, native and host tools,
media, nested subagents, continuation hits and misses, cancellation, failures and
structured output where the native surface has them. The `*.live.test.ts` files
repeat the key scenarios against the real, signed-in CLIs when `CODEX_LIVE`,
`CLAUDE_LIVE` or `ANTIGRAVITY_LIVE` names an executable.

## Antigravity

Antigravity runs through the Antigravity CLI's headless mode, the only surface
that uses the Google account plan (the Antigravity SDK accepts only Gemini API
keys or Vertex). Each call is one `--input-format stream-json` process for one
turn: the adapter writes a single user event, closes stdin, and translates
`step_update` and `result` events. Input is text only, so discovery reports no
image or file input; the stream carries no reasoning text, only reasoning token
counts. `--disable-slash-commands` keeps user text literal. Abort sends SIGINT,
and the CLI ends with an interrupted result.

An append-only prompt resumes its remembered conversation with
`--conversation <id>` after checking the CLI still stores it; otherwise the
fresh conversation receives system instructions and the transcript as text,
because the CLI has no system prompt option. Usage sums the turn's own steps;
`input_tokens` excludes cache reads.

The CLI loads MCP servers only from its global `~/.gemini/config/mcp_config.json`
and expands no variables there. Before a call with OpenChart tools, the adapter
ensures one fixed `openchart` entry: a bash relay that forwards stdio to the
loopback port in `OPENCHART_AGY_MCP_PORT` after sending the request's random
token. Each call serves its tools on its own port with a minimal MCP server, so
tools, outcomes, and tokens never cross requests; without those variables, as
in the user's own sessions, the relay exits. The adapter also adds
`mcp(openchart/*)` and a read rule for the CLI's generated tool schemas to
`~/.gemini/antigravity-cli/settings.json`. The CLI's schema reads and
`call_mcp_tool` steps for OpenChart are always hidden: the host server reports
each call with its exact outcome, and a denied call ends the turn with an error
naming it. Native subagents run as background
conversations whose steps never reach the stream, so `invoke_subagent` stays an
ordinary tool call.

Discovery reads `antigravity models`, whose rows pair a model with an effort
(`gemini-3.1-pro-low`). The binding merges them into one model per base ID with
efforts as variants; the CLI requires an effort, so the binding defaults to
medium, then high. Quota reads `/usage`, which spends no model tokens: each model
group's 5-hour and weekly buckets become model-scoped percent meters. Both run
with a closed stdin, so a signed-out CLI fails at once instead of starting
sign-in.

The CLI signs in only from a terminal: piped stdin is read as a prompt. Its login
command therefore runs `/bin/bash`, which starts `/usr/bin/script` to give the CLI
a pseudo-terminal. `script` rejects the socket the host passes as stdin, so bash
feeds it an anonymous pipe from `cat`, and Settings' input still reaches the
authorization-code prompt. Linux `script` waits for that pipe to close and then
misreports the exit status, so the command records the CLI's status, stops the
feed itself, and exits with that status. The user approves in the browser, pastes the shown
code within 60 seconds, and the CLI stores its token in the macOS Keychain (or
under `~/.gemini/antigravity-cli/`). Windows has no pin: its archives are zip
files and it has no `script`.

## Model references and shared constants

[`model-tiers.ts`](../../common/models/src/model-tiers.ts) owns OpenChart's
`CODEX`, `CLAUDE_CODE`, `ANTIGRAVITY`, `TIER1` through `TIER5`, and tier classification;
each provider's native mapping lives in `providers/<id>/tiers.ts`.
OpenChart bindings and consumers import these constants;
independent provider adapters keep their native identity strings locally.
Each provider maps a tier to one flat, ordered array of native aliases/versions.
Discovery establishes availability; this table never manufactures available models.

Product prompts, schedules, defaults, and profile selections accept only
`codex`, `claude-code` or `antigravity` plus `tier1` through `tier5`. `AgentPromptModel` derives
these literal fields from the shared `MODEL_PROVIDER_IDS` and `MODEL_TIER_IDS`.
Unknown providers and native model IDs fail boundary parsing before admission.
The provider registry uses the same native provider list by default.

The `models.list` endpoint exposes only supported provider/tier choices. Each
choice retains the resolved model's native name and metadata, with its logical
tier as the selection ID. Frontend menus show tiers actually present in discovery;
saved higher-tier selections may display a provider-local downward fallback.
Unavailable selections stay unresolved. No separate display name is persisted.

Provider-level `getModel` still accepts exact native IDs for resolved execution
and internal SDK use. Native discovery metadata and historical execution facts
retain actual SDK identities. Tightening product inputs does not rewrite history
or convert existing explicit selections; unsupported authored inputs must be
reselected using a supported provider and tier.

## Configuration

`settings.json` owns application model configuration under `models`.
[`server/models/config.ts`](../../server/models/config.ts) declares its Effect
Schema, shared by the public Config API and the native ConfigProvider recipe:

```json
{
  "models": {
    "permissionMode": "full-access",
    "providers": {
      "codex": { "enabled": true },
      "claude-code": { "enabled": true },
      "antigravity": { "enabled": true }
    },
    "defaultModel": { "providerID": "codex", "modelID": "tier1" }
  }
}
```

Codex, Claude Code and Antigravity are the registered model providers and default
to enabled. Settings inspects each even when disabled. Enablement controls model selection and
inference, not inspection. CLI accounts and credentials remain owned by the native
provider; there is no model API endpoint or API-key configuration.

`permissionMode` is one cross-provider preference: `ask`, `auto`, or
`full-access` (default). Settings > Models exposes these as **Ask**, **Auto**, and
**Always allow**, using the shared Config mutation and file persistence path.
Existing explicit choices are preserved. Its execution semantics are:

- `ask`: already authorized operations proceed; the user reviews requests for
  additional permissions.
- `auto`: the same workspace boundary applies, but an AI reviewer approves or
  denies requests for additional permissions.
- `full-access`: remove the native sandbox and skip ordinary provider approvals.

LLM reads this setting once at the start of each provider-managed request and
passes it through `ProviderRequestContext`. Bindings own the native mapping:

| Mode          | Codex                                                   | Claude Code                                                                    |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ask`         | `workspace-write`, `on-request`, `user` reviewer        | `default`, sandbox enabled                                                     |
| `auto`        | `workspace-write`, `on-request`, `auto_review` reviewer | `auto`, sandbox enabled                                                        |
| `full-access` | `danger-full-access`, `never`                           | `bypassPermissions`, `allowDangerouslySkipPermissions: true`, sandbox disabled |

Antigravity's headless mode cannot ask: `full-access` passes
`--dangerously-skip-permissions`, while `ask` and `auto` deny native actions the
user has not pre-approved in the CLI's own settings, without an AI reviewer. The
CLI ends the turn at the first denial; the adapter reports it as an error that
names the denied actions.

Codex sends policy on thread creation and every turn, so the turn's cwd owns
the writable workspace. Claude enables sandboxed Bash auto-allow in `ask` and
`auto`, permits approved sandbox escapes, and fails if sandboxing is unavailable.
All adapters include policy in their continuation key: changing it creates a
fresh native conversation with replayed application history, without carrying
over previous permission grants. Changes affect subsequent requests, do not
interrupt active requests, and do not rebuild the provider registry.

In `full-access`, native approval callbacks also allow without invoking the
application's approval flow. OpenChart tools still execute their own policy
inside their execution callback, so an application denial stays a tool error.
Native authentication, operating-system access, enterprise restrictions, and
explicit native deny rules/hooks remain native controls; this setting does not
remove them. Auto-review availability and model support remain provider-owned.

`defaultModel` is optional; omitting it keeps the first-available picker behavior.
It supplies the frontend selection until the user chooses a current model.
Submission records the chosen provider/model reference/variant in immutable Run
input. Model selection accepts only supported provider and tier IDs. Later default
changes do not rewrite queued inputs or rebuild SDKs.
The shared Config mutation/SSE path is described in
[configuration](configuration.md).

Provider SDKs and CLI adapters retain their native settings, environment, and
authentication mechanisms. Catalog storage/download options belong to
`catalog.ts`; they are not a slice of application configuration. Desktop installs missing pinned native runtimes at startup. Native credentials stay
in their existing locations; OpenChart neither copies auth nor downloads model weights.

## Runtime ownership

`model-provider.ts` owns the pure discovery data schemas and the standard AI
SDK access contract. `AvailableModel` contains the SDK model ID, provider ID,
display name, model kind, capabilities, costs, limits, selectable variant
names, and an optional positive integer `tier`. `model-tiers.ts` assigns tiers from
each provider's ordered mapping; higher numbers indicate higher capability tiers within
a provider and model kind. An omitted tier means unclassified: the model remains
discoverable and directly usable, but does not participate in selection by tier.
`AvailableProvider` contains provider identity and its model list.
Credentials, environment names, adapter packages, headers, options, release dates,
and native variant parameters stay outside model metadata. Setup results carry
installation readiness or the selected managed executable and login arguments.
Input/output modalities describe capabilities independently of model kind.
The contract imports no implementation, server, or Effect modules.

Request transforms consume this same `AvailableModel`. Request options accept
the resolved `{model, variant}` selection and explicit overrides, then merge
defaults < overrides < selected variant. Availability is checked once during
resolution; native parameter translation stays internal to the transform.
Provider routing uses
`providerID`, model-specific rules use the SDK `id`, and SDK options namespaces
are mapped from provider identity (`codex` uses `codex-app-server`). Unknown
providers fail explicitly. Requests use advertised variant names without
carrying catalog-only fields.
An unavailable or untranslatable selected variant fails before model I/O.
Unknown input capability metadata never rejects an attachment as unsupported.
Provider-specific defaults and variant translations cover only the native providers.
Ordinary SDK calls retain namespace routing and explicit option passthrough for
protocol tests, without API-specific model heuristics or message rewrites.

### Native setup lifecycle

`server/models/onboarding/` owns the manifest, installation, startup reconciliation,
login jobs, errors and setup state. Outer model modules retain the registry and
protocol/RPC boundaries. `ProviderDiscoveryResult` has three states:

```text
Managed runtime installed? -- no --> not_installed (Settings: Install)
      yes
Native authentication available? -- no --> authentication_required (Sign in)
      yes
Native model discovery -> catalog enrichment -> tiers -> ready
```

The app ships adapter/SDK JavaScript and downloads missing native artifacts in the
background at startup. `manifest.ts` pins official archive URLs, SHA-512
integrity, archive layout, exact versions and executable paths per OS/architecture.
npm hosts the Codex and Claude tarballs (payload under `package/`); GitHub releases
host Antigravity's flat tarballs. Hosts are only artifact sources: no npm
executable, global installation or native updater runs.
Claude Agent SDK 0.3.284 is paired with Claude Code 2.1.284; Codex is 0.159.0 and
includes its app-server subcommand and companion resources. Desktop staging omits
SDK optional native packages, keeping the initial app lightweight.

Installations live under `<Home>/model-providers/<provider>/<platform-arch>/<manifest-hash>`.
The hash includes every artifact field, so even a same-version pin change selects
a new target. Downloading streams to a temporary directory. Checksum verification,
archive path/type validation, extraction of all companion files, executable permissions
and an exact `--version` check precede atomic directory publication. Failed or
cancelled operations await cleanup and never publish an incomplete installation.
Completed older targets remain available on disk but are never used as a fallback.

App startup checks every provider's current pinned installation directory in the
background, including disabled providers. An unchanged target does nothing; a
missing target downloads automatically on first launch or after a manifest change.
Failure remains visible with an Install retry action; app startup does not wait for
network. Restart retries an unfinished download.
Bindings receive fixed absolute paths and never search PATH, Claude Desktop, Codex
Desktop or ChatGPT. Claude self-update, Codex startup update checks and Antigravity
self-update (`AGY_CLI_DISABLE_AUTO_UPDATE=true`) are disabled.

Settings sends only provider ID and `install`/`login` to `models.startSetup`. The server
validates the action, returns an accepted job, and runs it within the model scope.
Only login accepts stdin. Native login uses trusted argv without a shell and inherits
HOME, CODEX_HOME and CLAUDE_CONFIG_DIR; the CLI owns browser authorization, Keychain
access, token refresh and credential persistence. Existing native sign-in can therefore
be reused. No per-install auth directory or copied token is introduced.

One job per provider may run. Cancellation, the 15-minute deadline and shutdown await
native process/download cleanup. Progress and bounded login output stay in memory,
never settings, events or logs. Active jobs are polled. Startup/completion notifications
invalidate Settings and the composer setup indicator; after installation/login, only that provider's client is refreshed
and native sign-in is checked again. Another provider's active requests are preserved.
Explicit Check again still replaces the registry. Check failures remain errors rather
than becoming logged-out results. Ready and enabled providers are selectable.
Each Settings provider row has one action: Install when absent, Log in when signed
out, Cancel during setup, and the enable switch only when ready. Enablement defaults
to true; onboarding preserves an explicitly disabled provider.

The discovery pipeline starts with provider-native discovery, enriches the discovered
models with matching models.dev metadata, then classifies and orders them with the shared
tier mapping. Native discovery owns availability; catalog entries
alone never make a model available. Models without a tier remain unclassified.

Native discovery supplies model `id`, `name`, optional `description`, and known
`availableVariants`; bindings assign `providerID` and `kind`. Codex uses `model`
as its SDK ID, while Claude Code uses `value` unchanged, including aliases and
context suffixes.
Claude's `resolvedModel` can match catalog metadata and tier aliases without replacing that ID.
Claude's name uses the native `displayName`, which includes the model version.
The full description is preserved separately. Pickers therefore show versions
such as Fable 5.1, Opus 5.5, and Sonnet 5.5 without parsing model IDs or
maintaining a second name mapping.
The binding excludes the CLI's `default` selection alias from public discovery.
Native capability metadata is partial; models.dev supplies missing capabilities,
costs, and limits. Omitted `availableVariants` means unknown, while `[]` means
no selectable variants. Missing native effort metadata must not default to `[]`.
Individual capability facts, costs, cache rates, and limits may be omitted when
unknown. Missing metadata never implies zero cost, zero capacity, or an unsupported
capability. Catalog prices are reference API rates, not the native account's bill.

Codex implements this contract through `codex.createModelProvider(catalog, executable)` in
`providers/codex/binding.ts`. Construction creates no process or catalog I/O; the native
process starts on discovery or the first model call. Discovery reads
`account/read` without initiating login, then follows every `model/list` cursor,
including hidden picker entries. The managed installation check runs first. Missing authentication returns `authentication_required`; startup, RPC,
parsing, and catalog failures reject.
Duplicate SDK model IDs and repeated cursors reject
instead of returning partial discovery.

Codex starts from its manifest-selected executable and retains its native account and
configuration locations. The installation owner enforces the exact release
version; the adapter trusts the pinned protocol and enables the experimental API
capability it needs for dynamic tools.

Exact SDK model IDs match the OpenAI models.dev catalog. Native identities,
efforts, and input modalities take precedence; catalog-only models are never
advertised. The preferred mapping is `gpt-6-luna` → tier 1, `gpt-5.6-terra` → tier 2,
`gpt-6.1-sol` → tier 3, and `gpt-6-astra` → tier 4, with older Luna/Sol versions as
fallbacks. Results sort by descending tier, then each tier's
mapping order. Unclassified models follow in native order. Repeated discovery
reads native state again and reuses the catalog reader's snapshot.

Each binding owns its SDK instance; there is no global Codex singleton.
`ModelProvider.dispose()` is idempotent and terminal, releasing the native process
and shared MCP resources. The owning Effect service registers and awaits
finalization for its scope. Per-call cleanup still owns each request's
MCP resources and handlers; finishing a call does not dispose the provider.

Claude Code implements the same contract through
`claudeCode.createModelProvider(catalog, executable)` in `providers/claude-code/binding.ts`. Construction
performs no I/O; the binding resolves its explicit CLI path on first use. Native
`auth status --json` establishes local login availability before SDK
`supportedModels()` reads model metadata. Initialization can return models even
while logged out, so a model list alone never proves availability. A native query
error result, including `is_error` on a `success` subtype, becomes a model request
error with the CLI's message. Discovery submits no user prompt and always closes
its temporary Query. Authentication
and SDK startup/timeout errors reject; an explicit logged-out status returns `undefined` internally. The binding maps
that to `authentication_required`; a missing executable maps to `not_installed`.

Discovery and inference inherit Claude Code's native user, project, and local
settings. Native `cwd` determines project settings lookup. Strict MCP
configuration keeps the operator's own MCP servers out of OpenChart runs, so
Claude's browser and computer-use surfaces are not reachable from OpenChart;
request-scoped permission callbacks remain explicit OpenChart options.

Standalone adapter calls with omitted `permissionMode` defer to Claude Code's
`permissions.defaultMode`; OpenChart inference always supplies its saved mode.
The pinned Agent SDK 0.3.284 otherwise injects `--permission-mode default`, which
overrides filesystem settings ([upstream issue #230](https://github.com/anthropics/claude-agent-sdk-typescript/issues/230)).
`providers/claude-code/adapter/native-query.ts` enables its runtime `resolvePermissionModeInCli`
switch for discovery and inference. This switch is absent from the SDK's public
types; real SDK process-argument tests guard the bridge and explicit mode
overrides. Remove the bridge when an installed SDK defaults to native resolution
or exposes a public equivalent. OpenChart overrides permission and sandbox mode
per request while retaining unrelated native configuration and authentication.

Claude uses only its managed executable. Its SDK receives the explicit path for both
discovery and inference; the SDK's bundled/PATH fallback is never selected by OpenChart.

Claude model `value` is preserved verbatim for `sdk.languageModel()`. Exact
`resolvedModel` (or `value` when absent) matches enrich metadata from the Anthropic
catalog. Context suffixes are never stripped to guess a base model's limits.
Native effort levels and positive adaptive-thinking capability override catalog
metadata. Explicit unsupported effort selection gives `[]`; missing effort
metadata stays unknown. Explicit aliases/canonical IDs map haiku → tier 1,
sonnet (including Sonnet 5.5) → tier 2, opus → tier 3, and fable (including Fable 5.1) → tier 4, with
descending tiers and mapping preference followed by unclassified models in
native order.

Claude model calls each own their Query and its CLI process. Provider disposal
interrupts active calls and prevents new use through retained model handles.
Callers still own consuming or closing response streams. The sanitized
subprocess environment is shared by discovery and inference; request tool and
permission closures remain confined to their request. Both native bindings use
the pure `providers/model-catalog.ts` enrichment projection.

`server/models` directly constructs every native binding regardless of
application enablement, without discovery or inference. There is no intermediate
registry API in `common/models`. The Models service owns selection, list caching,
refresh, and binding cleanup; adapters and discovery contracts remain shared.

`discover(providerID)` inspects only that binding, including disabled providers.
`list()` discovers enabled bindings concurrently, preserves registration/model
order, and includes only `ready` results. A ready provider with no models is valid.
Binding and ready-provider IDs must match their registered route. Discovery failures
use `ProviderInit` with provider identity and the original cause. `list()` omits a
failed provider, so one provider never hides the others; `discover` and
`getModel` still report the failure.

`getModel(providerID, modelID)` reads only the enabled binding's current discovery.
Explicit SDK IDs match exactly, including aliases and context suffixes. Logical
`tier1` through `tier5` select the highest available tier at or below the requested
tier within that provider, using common/models' pure tier resolver. Same-tier
candidates retain mapping order; unclassified models never substitute. Unknown,
disabled or unavailable providers and missing models fail with `ModelNotFound`
carrying both IDs. Unrelated providers cannot prevent a lookup.

`getLanguage(model)` borrows the binding's standard `sdk.languageModel(model.id)`
without rediscovery or a handle cache. SDK initialization failures become
`ProviderInit`; SDK model-not-found failures become `ModelNotFound`.
Unexpected factory failures remain defects. Handles borrow their binding's lifetime.

The Models scope owns every binding and awaits all cleanup, retaining failures in
an `AggregateError`. Its closed scope prevents in-flight discovery/model lookups
from returning disposed state. Setup refresh releases and replaces only the changed
binding, then invalidates the list cache; other providers remain usable.

`ModelsDev.create` still owns one lazy catalog snapshot and its parsed disk and
network boundaries. Concurrent reads share one load; failures propagate and clear
the memoized promise so the next read can retry. Successful snapshots remain cached.
Parsing retains only capabilities, costs, and limits; provider
and model record keys supply catalog lookup identity. Upstream display metadata,
SDK package names, request settings, and variant definitions are discarded at
the boundary. The cache remains a copy of upstream JSON and is projected on read.
Bindings use `catalogModelMetadata()` to enrich only models
found by native discovery. Native parameter translation remains internal.
Existing native adapter implementations and their protocol ownership remain intact.

`Models.layer(catalogOptions)` consumes the native ConfigProvider, its updates,
and Events. It owns one lazy catalog and an Effect `ScopedRef` for the active
registry. Provider configuration changes and explicit refresh replace the registry
and dispose the previous instance. Default-only changes leave it intact. Replacement
recreates all bindings and may fail active requests. `models.changed` publishes
after replacement so clients refresh independently of the Config mirror.

`Models.Service` exposes `discover`, `refresh`, setup actions, `list`, `getModel`,
and `getLanguage` directly. Each
operation reads the current registry. Prompt, title, compaction, and workflow
children use this shared service without fixing a registry for the invocation.
Run inputs retain the requested provider and tier. At invocation preparation,
Prompt resolves a native model once and reuses it across model steps. Each later
invocation, including a scheduled firing, resolves again. Assistant metadata and
request snapshots record the actual native ID. Provider replacement may still fail
an active call; this selection snapshot does not retain a disposed registry.
One observer processes configuration and credential updates in
order. It subscribes to credential events before refreshing and re-subscribes
after bounded-queue overflow. ScopedRef owns replacement and cleanup; callers
do not participate in registry lifetime management.

`list()` uses a lazy Effect cache per registry, keyed by provider and sharing
concurrent discovery. Successful results are cached for one hour; failures expire
immediately so the next call retries only that provider. `getModel()` continues to query the current registry directly.
Invalid settings dispose the previous registry and fail lookups with
`Models.ConfigurationUnavailable` until the file is fixed. Provider construction
failures remain observable through the same service methods.

Callers select a tier through `getModel(providerID, TIER1)` just like any other
model reference. Title generation resolves its configured profile model or the
conversation provider's tier 1, without inheriting the conversation's variant.
Unavailable title models leave the default title unchanged through the existing
expected-error handling.

LLM requires the caller's resolved model snapshot. Its internal
`validateSelection(input)` validates the explicit variant before SDK access,
failing with `LLM.VariantNotFound` when unavailable. Request preparation never
rediscovers or substitutes a model.

`getLanguage` reads the current binding directly. Individual requests release their
own resources without disposing shared providers; Models awaits shared cleanup.

`server/agent/llm/llm.ts` keeps its existing request preparation and two execution
paths internally: provider-managed MCP for the registered native providers, and
ordinary AI SDK execution used by protocol tests. Both obtain their standard SDK
model through the scoped Models service. No API provider is registered.
There is no separate request abstraction or duplicate portable tool contract.

The request input keeps `user.model.selectedVariant`, agent options, and request
headers, and requires a resolved `model` snapshot from Prompt. LLM uses that
selection without rediscovery for SDK
access, request transforms, provider routing, headers, and output
limits. `ProviderTransform.options(selection, agentOptions)` owns the merge order:
defaults < agent options < selected variant. LLM no longer injects
OpenAI storage or Anthropic caching defaults; explicit overrides remain available.
Header construction and the exact-answer heuristic stay at the call site.
Tool schemas still derive from the caller's authoritative
Effect decoder, which runs before execution. Request snapshots complete before
model I/O; the outer prompt loop continues only after durable tool settlement.

The provider-managed branch passes the borrowed LanguageModelV4 straight to
streamText; adapters already emit exact host tool outcomes. Delegate markers
are conformed afterward, preserving AI SDK root-step accounting. Tool and
permission callbacks remain request-bound; native settings stay inside their binding.

`native-provider.ts` defines `ProviderRequestContext`, grouping the host-resolved
absolute `cwd`, `tools`, and `askPermission` for each native Agent call. Bindings map this context to native
request options. Claude passes cwd to each query; Codex passes it to thread
start and to every turn without changing its shared process. Workspace
registration lookup and default selection remain server-owned.

The stream aborts before awaiting iterator cleanup on every termination path.
This ordering prevents an idle delegate transform from blocking cancellation
while its native source waits for that abort. SDK error events become typed
request failures; malformed protocol data remains a defect. Native adapters stay
independent of the shared schema implementation.

The processor-facing stream boundary remains:

```text
getModel -> getLanguage -> LLM request preparation
  Ordinary SDK:      streamText -------+
  Provider-managed:  streamText -------+-> conformProviderStream
                                         -> typed LLM Effect stream
```

The conformer runs after the AI SDK stream and preserves the protocol's root
and child step ordering. Constructing a LanguageModel or receiving text alone
does not establish delegate protocol conformance. LLM integration tests exercise
nested success and child-error ordering through the real Models Layer and AI SDK,
asserting exact parent/child routing, child-before-proxy completion, separate text,
and preserved root aggregate usage. Concurrent MCP integration tests reuse one
model handle and identical tool-call IDs across requests to verify outcome
isolation, exact object restoration, and single execution. Both native suites
continue to exercise their
twenty native scenarios through the canonical conformer.

LLM exports `LLM.Service` with a `stream(input)` method. `LLM.layer` supplies the
lazy implementation; each consumption resolves `Models.Service` and owns a request
Scope for stream and callback cleanup. Application composition supplies Models, Integration, Events, and Config
through `server/runtime.ts`; another Layer can replace the LLM implementation.
Tests cover immediate registry disposal, configuration recovery, encrypted credential
rotation (including during construction), and real compatible-adapter streaming
with tool continuation and authentication failures against a local HTTP server.
These tests do not establish live API-provider or native-account acceptance.

## Plan quota

[`provider-quota.ts`](../../common/models/src/provider-quota.ts) owns the
provider-agnostic `ProviderQuota` contract: the signed-in native account's plan
meters, which Settings shows beside each provider. A `QuotaMeter` has an
`account` or `model` scope, a `duration` or `month` window, `usage` as either the
provider's own `percent` or `spend` against a money cap, and a UTC `resetsAt`.
Meters carry no ID and a read carries no timestamp: each read replaces the whole
list, so the app keys rows by position and records when the response arrived.
Omitted fields are unknown; zero and false are provider facts. Labels such as
"Weekly · Fable" and spend fill (`used / limit`) are app presentation and never
enter the contract. Model scopes carry only the provider's bucket name.
`not_applicable` means the native account has no plan limits (API key, Bedrock,
Vertex); failed reads reject instead.

```text
Settings provider row (ready) -- every visit --> models.quota({providerID})
  -> Models.quota(id), uncached
    -> ModelProvider.readQuota()
         Claude Code: SDK usage control request -> binding translation
         Codex: account/rateLimits/read         -> binding translation
         Antigravity: `-p /usage` JSON          -> binding translation
  <- ProviderQuota, parsed once at the binding boundary
  -> one UsageRing per meter; hover shows label, percent, spend and reset
```

`ModelProvider.readQuota()` reads native state on every call, independently of
enablement, and never installs, starts login or changes native settings. Adapters
return native shapes; bindings translate them, keeping native field names out of
the contract. Claude Code runs the SDK's experimental `usage` control request on
a query that never sends a message, the same way discovery reads models; Codex
reads every `rateLimitsByLimitId` bucket; Antigravity runs its `/usage` command.
All normalize reset instants to `Z`;
Claude Code scales minor-unit extra-usage spend to major units. Quota is
read-only account state: it never
participates in discovery, the model list, model resolution or request routing,
and no layer caches it. A failed read becomes `Models.QuotaUnavailable`
(`models.quota` at the transport boundary) and never makes the provider
unavailable. The Settings row reads quota only once discovery is ready, with the
discovery query key as prefix so "Check again" and login refresh both together.

## Native questions

Provider request context carries `askQuestion(request, {signal})` independently
of permission policy, including in `full-access` mode. Bindings normalize native
inputs to `ProviderQuestionRequest` and translate `answered` / `skipped` replies.

- Codex: enable `features.default_mode_request_user_input`; parse
  `item/tool/requestUserInput`, return `{answers: {[id]: {answers: string[]}}}`.
  `serverRequest/resolved`, turn completion, and process exit cancel outstanding
  callbacks. The adapter emits a native `request_user_input` tool call/result so
  fresh-thread history retains the user's answers. Skipping returns no answers.
  Native `agentMessage.questions` (`request_user_input_async`) reuses the same
  host callback without blocking notifications. A request-local bridge deduplicates
  items and steers an answer once into the originating thread and expected turn.
  These waits expire after 60 seconds, on native turn/delegate completion, or on
  request cancellation/process exit. Skips, late answers, and delivery failures
  never retry or start another turn. The adapter emits an async question tool
  call/result for history; no outer question contract or persistence is added.
- Claude: intercept `AskUserQuestion` in `canUseTool` before automatic approval;
  preserve input and add `answers` keyed by original question text to the allow
  response. Multi-select labels are joined with `, `. Skipping returns a deny
  response explaining that no answers were provided. The SDK emits the transcript.

- Antigravity: headless turns cannot ask; native questions go unanswered.

Codex and Claude share the LLM callback scope and cancellation bridge. Title/compaction calls
without a question capability decline rather than opening an unowned UI wait.
