# App connection

- `use-backend-connection.ts` owns shared transport, readiness, and
  Resource/Config/Workspace observers. Agent clients and observation belong to `lib/agent/use-agent.ts`.
- Mount once from Layout so child-route navigation preserves the connection.
  Manual reconnect replaces transport; Layout keys consumers by `attempt`.
- Reconnect hides retired services before supplying the new scope.
- Cleanup releases app subscriptions and cached Config. Features release their
  own subscriptions; durable backend executions keep their independent lifetimes.
- This is app composition: keep it outside shared `lib/` and `hooks/`.
  Theme, notices, and navigation remain in Layout.
