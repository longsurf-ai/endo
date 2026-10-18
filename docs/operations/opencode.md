# OpenCode in Endo

Endo can run OpenCode as a native coding harness. OpenCode owns the coding loop,
provider connections, authentication and native configuration; Endo owns chat
history, workflows, application tools and their results.

## Runtime and configuration

Endo installs its own verified OpenCode runtime through the normal provider setup.
The initial managed runtime is OpenCode **2.0.32 on macOS Apple Silicon**. Other
platforms report an unsupported runtime until an official artifact is added to the
manifest. Endo does not search PATH or replace a Homebrew installation.

The managed runtime inherits your normal OpenCode configuration and credentials.
Configure providers in OpenCode, then use **Settings → Models → Check again** in
Endo. Existing OpenCode CLI installations can manage that shared native setup.
A local compatible endpoint does not require an OpenCode account when the endpoint
itself needs no authentication.

For example, a V2 native configuration can define a local endpoint:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "private/local-coder",
  "providers": {
    "private": {
      "name": "Private models",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://localhost:8000/v1" },
      "models": {
        "local-coder": {
          "modelID": "actual-served-model-id",
          "name": "Local coder",
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"]
          }
        }
      }
    }
  },
  "policies": [
    { "action": "provider.use", "resource": "*", "effect": "deny" },
    { "action": "provider.use", "resource": "private", "effect": "allow" }
  ]
}
```

Use the model ID currently served by the endpoint. `modelID` maps a stable native
selection such as `private/local-coder` to an upstream ID, so a server rename need
not invalidate saved Endo selections. Provider authentication settings depend on
the endpoint and remain in OpenCode's native setup.

Endo preserves native provider policies. Denied providers are not added through
catalog enrichment, and an unavailable explicit selection fails instead of
switching to another model. These restrictions govern model providers; native
plugins, web tools, integrations and endpoint retention have their own data paths.

## Model selection

OpenCode's allowed global models appear in the chat picker and default-model
settings. Each selection retains its full native `provider/model` identity and
known effort choices. Endo does not assign quality tiers to arbitrary configured
models. Existing harnesses retain tier aliases; unmapped models appear as direct
choices. Titles for an unmapped selection use that selected native model.

Menus are discovered from the home directory's native configuration. Each actual
request uses the selected Endo workspace as its native working directory, so
workspace rules, instructions and restrictions still apply. Models defined only
in project configuration need a global definition to appear in Endo's picker.

## Tools, permissions and sessions

Native coding tools remain inside OpenCode's loop. Endo application tools are
injected through a request-scoped authenticated loopback MCP server. Native
codemode steps and original Endo tool outcomes remain distinct in the transcript.
Child sessions are displayed through native child-session events.

- **Ask** forwards native approval requests to Endo using a dedicated request
  agent. Existing native saved grants and managed restrictions still apply.
- **Auto** uses OpenCode's configured native permission rules and forwards any
  approval it requests to Endo.
- **Always allow** accepts native approval callbacks for this request. Native
  provider policies remain enforced.

Every call receives Endo's complete authoritative history. Compatible follow-ups
can resume a private native session; edited histories and incompatible settings
start fresh. A failed prompt is never automatically replayed after it might have
executed tools. Cancellation interrupts native work and closes request resources.
Native session storage remains OpenCode-owned.

## Current limits

The adapter accepts text input. ACP transport image support does not imply image
support for every configured model. OpenCode does not expose one consolidated
account quota, so Endo reports no quota meters for this harness. Reported native
turn usage excludes child-session usage.

Structured workflow output uses a schema-bound MCP submission tool. The submitted
value is validated; missing or invalid output fails explicitly. This requires a
model that can use tools. Native forms that can be represented as text or choice
questions reach Endo; unsupported forms are declined.

OpenCode still reads its usual native configuration files, including supported
JSONC files. If the process inherits `OPENCODE_CONFIG_CONTENT`, that inline value
must currently be JSON so Endo can preserve and merge it into its request overlay.
Generated instructions are escaped to prevent native configuration substitutions.

## Development validation

`just check` includes offline protocol, binding, selection and setup tests. Live
native tests are opt-in and use synthetic temporary workspaces:

```sh
OPENCODE_LIVE=1 \
OPENCODE_LIVE_EXECUTABLE=/absolute/path/to/opencode \
OPENCODE_LIVE_MODEL_IDS='["private/local-coder"]' \
npm exec vitest -- run common/models/src/providers/opencode/adapter/opencode.live.test.ts
```

Add `OPENCODE_LIVE_EXTENDED=1` to exercise resume, permission refusal, native
child-session stream conformance, shell cancellation and choice questions.
Keep actual endpoint URLs, credentials and test
logs outside the repository. Verify UI changes in Electron using `just desktop`.
