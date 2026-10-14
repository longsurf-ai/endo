# Configuration

`settings.json` is the source of truth for application preferences, notifications
and Models. The file lives at `<home>/settings.json` in the host-selected
backend profile. Native model CLIs keep their own credentials.

```text
Settings UI -> Query mutation -> tRPC config.update -> settings.json
                                                        |
                config.get <- Query invalidation <- config.changed / SSE
                                                        |
                         native ConfigProvider snapshots + updates
                                |
                         Models ScopedRef (current registry), Notification
```

## File ownership

`server/config/provider.ts` owns reading, atomic replacement and 250 ms polling.
One semaphore serializes application writes and polling. A write rereads the
latest file, applies JSON Merge Patch, validates the affected domains, writes a
sibling temporary file and renames it into place. Only then does it update the
native snapshot and publish `config.changed`. Committed publication finishes
even if the HTTP caller disconnects. Identical observations and no-op patches
are deduplicated.

Missing files permit domain defaults without creating a file. Malformed JSON,
non-object roots and null values fail startup. Invalid live changes replace the
readable snapshot with an observable error and trigger invalidation; correcting
the file restores reads. Storage failures never become empty settings. Scope
disposal stops polling. External editors do not participate in the semaphore:
concurrent external replacement remains last-writer-wins, not a file transaction.

`runtime.ts` installs this source before consuming services. Explicit native
providers passed through `makeRuntime({config})` remain useful for tests and
embedding: reads use that provider and config mutations fail as read-only.
There is no KeyValueStore alternative or second desktop file store.

## Domain declarations and public API

Each domain declares one Effect Schema for values and defaults. Missing keys
use `withDecodingDefaultKey`; native `Config.schema` reads the same schema in a
keyed enclosing struct. Avoid value-level default wrappers around a native
config namespace: in the installed Effect version they can mask malformed
nested input as absence. Regression tests cover invalid scalar namespaces and
invalid provider flags.

`server/config/router.ts` statically composes the public domains:

- `appearance.theme`: light, dark or system (default system).
- `notifications.sound`: a shared bundled sound ID (default `chime`), `system`,
  or `none`. Notification reads it at each delivery, so changes apply without
  restarting. There is no settings page for it yet. OS mute and notification
  permissions remain authoritative.
- `models.providers`: Codex and Claude Code default enabled. Settings inspects
  native readiness independently of enablement; native CLIs own their credentials.
- `models.permissionMode`: `ask`, `auto`, or `full-access` (default); a persisted
  cross-provider preference edited in Settings > Models as Ask, Auto, or Always
  allow. LLM captures it for each native request; bindings map sandbox and approval
  policy without changing OpenChart tool authorization. See the
  [model configuration contract](models.md#configuration).
- `models.defaultModel`: optional explicit provider/model/variant for later
  submissions; absence uses the first available model.

`config.get` returns decoded public settings with defaults, without writing
them into the file. Unmanaged namespaces remain in the file but are not exposed.
`config.update` accepts a strict derived JSON Merge Patch: omission leaves a
field alone, objects merge, arrays replace, and null removes a key. Null never
persists. Unknown patch keys fail, including unknown keys set to null. The patch
does not materialize defaults or apply checks needing complete objects; the
merged domain is checked before any file write. Public errors never expose
raw configuration or parser inputs.

## Consumers and notifications

The Config source emits immutable native ConfigProvider snapshots only to its
own observers. Models holds its current registry in an Effect ScopedRef.
Relevant config changes
replace the registry and dispose the previous instance, which may interrupt
active requests. New calls use the updated configuration. Defaults alone do not
recreate SDKs. Models publishes its own query invalidation after replacement.

`app/src/lib/config/config.ts` owns the Query mirror and an independent
`subscribeConfigInvalidation`. It shares the existing transport/SSE connection
with Resource and Agent observers. Initial ready, reconnect ready and
config.changed cancel obsolete reads and invalidate Config. Successful mutations
also refetch; refresh errors remain distinct from successful file writes.

Theme display uses native DOM classes/color-scheme and matchMedia.
It consumes Query data, with no theme preference store
or storage-event synchronization. A stable profile-scoped localStorage value is
read once before React mounts and refreshed only by successful Config reads.
It is a startup hint, never a config write source. OS appearance changes update
the display without changing the saved system preference.
