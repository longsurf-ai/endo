# Agent plugins

OpenChart supports trusted context preparation selected by agent name. The plugin catalog
owns definitions; each root or child Prompt owns fresh plugin instances. This is the
foundation for feature-specific context preparation. No plugins are installed by
default; see the end of this document.

```text
Application composition supplies ordered plugin definitions
  -> Prompt resolves profile data
  -> read all plugin definitions and select by agent name
  -> require a preparation owner for each typed plugin input
  -> commit trigger User and input Parts
  -> Plugin.create(definitions, invocation)
  -> provide Plugin.Service to the invocation execution
  -> yield Plugin.Service and trigger run.before
  -> Prompt wraps PluginContext[] as ContextPart[]
  -> Session.createParts commits the batch atomically
  -> ordinary Agent loop: Processor -> LLM
  -> invocation Scope closes and awaits cleanup
```

`server/agent/plugin/contract.ts` owns hook inputs and outputs. The existing
shared Part schemas own `PluginInput` and `ContextPart` with `context.kind: 'plugin'`. There is no second
plugin-input envelope, queue, run ledger, or application runtime.

`@openchart/server/agent/plugin` is the public Plugin boundary. `Plugin.create`
returns a `Plugin.Interface` instance; `Plugin.Service` supplies that same instance
to consumers. There is no separate Plugin runtime abstraction. Prompt creates one
instance after the trigger User commits and provides it to the entire execution:

```ts
const plugins = yield * Plugin.create(definitions, invocation);
yield * execution.pipe(Effect.provideService(Plugin.Service, plugins));
```

Lifecycle call sites only acquire the service and dispatch their hook:

```ts
const plugins = yield * Plugin.Service;
const contexts = yield * plugins.trigger("run.before");
```

`run.before` is the only hook. It returns `PluginContext[]` directly once before
title/model I/O. Each context contains `kind: 'plugin'`, `pluginId`, `hook`, and
`content`. Prompt assigns Part IDs and trigger Message ownership and writes the
resulting `ContextPart[]` through generic `Session.createParts`. Step
snapshots and Processor carry no plugin state or callbacks. Child prompts create
and provide their own instances; the invocation Scope owns cleanup through the
whole execution, including failure and cancellation.

`PluginRegistry.layer(definitions)` supplies the ordered catalog independently of
Profile. Each definition declares exact `agents` selectors. Prompt resolves
serializable profile `Info`, reads `registry.all()`, and calls
`PluginRegistry.resolve(all, profile.name)` to scan and validate matching definitions
without setup. Catalog construction copies and freezes definitions and selectors.
An active invocation retains its selected profile snapshot if Profile reloads.
Profile and plugin composition have no shared atomic update or registration
lifecycle; captured dependencies must outlive their invocations.

Definitions implement `create(invocation)` and return Effect handlers. The
invocation supplies authoritative run, session, trigger Message, and profile
identity, the complete ordered plugin inputs, and the invocation's selected model.
Creation detaches and recursively freezes this snapshot before setup. Handlers
access these fixed facts through their closure; hook inputs contain only facts
specific to that lifecycle point. `run.before` needs no additional input. The
selected model describes the invocation, not necessarily each later model request.
OpenChart has no per-user Agent ownership dimension.

Features that need application services can call `Plugin.bind(definition)` during
composition. It captures the required services while allocating plugin state and
cleanup under each later invocation's Scope. It does not run plugin setup early.
Service-free definitions can be registered directly.

Every input type must have one declared owner, and owners enforce their required
cardinality and business authority. Session owns generic Part batch transactions
and post-commit publication; it imports no plugin execution contracts. Part IDs
identify records. Plugin and hook names record source metadata and may repeat,
so every hook result is appended even if the prompt already contains the same
context. Prompt input accepts the same shape without requiring a registered plugin.
There is no output reconciliation or intermediate contribution type.

Forward migrations convert the old standalone `plugin_context` variant, then
replace its former contribution identity with `hook: 'run.before'` in transcripts
and Run/Schedule prompts. The former contract only produced persisted context
through this hook. Every record, Part ID, content value, and row timestamp survives.

Model replay omits plugin input and frames plugin context without asserting its
authorship. Client projections hide both as before.

Setup and hook failures terminate preparation before model I/O. Expected failures
retain plugin, hook, and invocation attribution. Effect interruption stops pending
hooks and closes plugin resources; Promise-based I/O should use Effect's supplied
AbortSignal.

Workflow definitions own their arguments and execution steps; plugins contribute
no workflow arguments. Cancellation and resource cleanup follow the executing
fiber and its Scope.
Workflow child prompts create their own plugin instances and prepare current
context on each invocation, including recurring scheduled execution.

No feature plugins are installed. `runtime.ts` passes an empty catalog to
`PluginRegistry.layer([])`; bind a plugin with `Plugin.bind` and add it there.
`PluginInput` is an open JSON object tagged by `type`: the registry rejects inputs
no selected plugin owns, and the owning plugin decodes its own fields in
`run.before`. Tighten it to a union of tagged structs when static validation helps.
