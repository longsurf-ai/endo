# App end-to-end checks

- Interactive app verification uses Desktop through Computer Use.
- `tests/agent-live.ts` is an opt-in CLI suite against an isolated local Agent backend.
  It consumes the production Agent client and SessionStore, without another
  reducer or runtime implementation. Run it via `npm run test:agent:live`; see
  [app validation](../README.md#validation).
- Live scenarios use installed providers and create test Sessions. They remain
  outside default CI and cancel their test runs and dispose subscriptions on exit.
