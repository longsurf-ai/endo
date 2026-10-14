# Permission

`server/agent/permission/` owns the Agent permission subsystem. Its public entry
is `@openchart/server/agent/permission`, exposing data schemas, Service, layer,
and the three approval APIs. Errors live in the errors subpath; Profile imports
only the pure types subpath to avoid a runtime dependency cycle.

## Ownership and dependencies

The Layer consumes AgentProfile.Service, Database.Service, Events.Service, and
Publisher.Service.
Application runtime constructs one instance shared across requesting and replying
calls. Each instance owns its pending Deferred map; saved grants belong to its
application database. Workspace and Location are not introduced.

Session lookup checks existence. Our Session has no agent field, so input.agent
selects the Profile, or the Profile service resolves its default when omitted.
An explicit `agent: null` selects no profile rules. Prompt uses that selection
for provider-native approval requests; OpenChart tool execution supplies its
Agent name and remains subject to profile policy. Both paths retain the same
approval callbacks, pending requests, replies, and saved grants. Sessions carry
no permission policy. The old per-user agent_permissions policy does not
participate in evaluation.

Profile owns construction of configured rules: built-in rules, common injected
configuration, then Agent-specific configuration. Permission reads the current
resolved Profile on each evaluation; it does not cache configuration or watch files.

## Decisions and approval

Rules use action/resource/decision, with Permission.Decision defining allow,
deny, and ask. Matching uses wildcard patterns. The last
matching rule wins; no match asks. Unknown Profiles deny.
Configured deny decisions are checked before remembered allow patterns, so saved
allow cannot bypass a configured denial. Across multiple resources, deny wins over
ask, and ask wins over allow.

| Method | Behavior                                               |
| ------ | ------------------------------------------------------ |
| ask    | Returns on allow, fails on deny, or waits for approval |
| reply  | Settles a pending request with once, always, or reject |
| list   | Lists this service instance's pending requests         |

Ask takes AskInput and returns an Effect of void: successful completion means
permission has been granted. When approval is needed, it registers the pending
request, delivers each affected Session's pending view through Publisher,
and waits for reply to complete its Deferred.
The caller owns the waiting fiber; interruption removes its pending request.

`list()` returns a detached snapshot of all pending requests. `list(sessionID)`
returns that Session's own requests and those of its delegated descendants.
Visibility follows persisted `kind: delegate` / `parentId` links and stops at
other Session kinds. It requires no ToolPart association or routing cache.
Request IDs and owning Session IDs stay unchanged: an ancestor UI replies to the
original request, and delegation does not alter permission evaluation or grants.

Once approves the requested operation. Always additionally saves the request's
save patterns, then re-evaluates other pending requests using their current Profile
rules and saved grants. An empty or omitted save list behaves like once. Reject
also rejects other pending requests in the same Session. Corrective feedback is
returned as CorrectedError; rejection without feedback aborts ask with a
DeclinedError defect. BlockedError reports prohibiting rules;
replies to absent requests fail with NotFoundError.

A mutation lock serializes evaluation, registration, and replies. It never spans
Deferred.await or a user interaction. Interrupted asks remove only their
own pending entry, even if its ID has since been reused. Service disposal rejects
remaining waiters, clears pending requests, and prevents further admission. Input and
list snapshots are detached from internal mutable approval state. Publishers receive
shared request references, must not mutate them, and own any copying needed for
retained or queued events.

## Persistence and events

permission/schema.ts owns agent_permission_grants. Each saved row records an
identity, action, resource, and timestamps, with a unique action/resource pair.
These are application-scoped allow grants; there is no fabricated user, project,
or workspace identifier. saved.ts performs reads and atomic inserts through the
existing Database connection, outside all approval waits.

A forward migration restores grant storage after its historical removal. Existing
migrations remain in the checksum-verified history. A separate forward migration
removes the unused Session permission column, preserving all other Session facts
and related rows. Legacy agent_permissions rows are preserved; their policy,
including yolo and deny, is neither converted into broader grants nor consulted
by this Service.

Registration, reply, and cancellation deliver the authoritative pending view for
the requesting Session and each delegate ancestor through Publisher under the
publication barrier. Each view uses `list(sessionID)`, so concurrent siblings
cannot overwrite each other's requests. The selected client adapter owns
wire encoding; the AG-UI adapter emits STATE_DELTA inside the application envelope. Always commits saved grants before
removing the pending request, publishing, and completing Deferreds; a failed
transaction leaves the request pending. Events are process-local notifications.
List provides the current state after reconnect; completed requests have
no pending history. Cancellation and disposal clear pending state without inventing
a user reply event.

The service and its migration are implemented and composed into application runtime.
Prompt binds tool and provider permission callbacks to this Service.
`agent.replyPermission` calls the shared Service; cold Session snapshots include
`Permission.list(sessionID)`, the same view as live updates. Snapshot reads do not
acquire Permission's mutation lock. The assistant-ui demo renders these requests
and submits once, always, or reject through that route, without subscribing to
child Sessions or requiring approval controls inside tool cards.
