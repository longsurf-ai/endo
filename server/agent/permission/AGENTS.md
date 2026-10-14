# permission

Owns evaluation, pending approvals, and application-scoped grants. See
[permission contract](../../../docs/architecture/permission.md).

- Runtime shares one Service across ask/reply/list. `types.ts` stays pure so
  Profiles import rules without a cycle. Sessions contain no permission policy.
- Evaluate current Profile rules: last wildcard match wins; no match asks,
  missing Profile denies. Saved allow never overrides configured deny.
  Across resources, deny precedes ask precedes allow. `agent: null` skips Profile
  rules for native requests, retaining approval and saved grants.
- Mutation lock serializes evaluation/registration/replies, never approval waits
  or model I/O. Duplicate IDs cannot replace waiters. Cancellation removes only
  its pending instance; disposal rejects waiters and closes admission.
- Replies are once/always/reject. Always commits declared grants before publication
  and release, then reevaluates pending requests. Failed writes leave requests
  pending. Reject also rejects that Session's other requests.
- `list(sessionID)` includes delegate descendants via persisted Session links;
  original request ownership/policy stays unchanged. Return detached snapshots.
- Publish each affected Session's complete view under Events.withBarrier.
  Bootstrap uses the same list without taking the mutation lock. Failed registration
  publication removes its waiter; cancellation invents no reply.
- Preserve corrective feedback and failure types. Legacy user policy is neither
  consulted nor converted into broader grants.
