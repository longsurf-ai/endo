# agui

Owns AG-UI projection and delivery. See [PROTOCOL.md](PROTOCOL.md).
Domain owners depend only on Publisher; runtime selects this adapter.

- Reuse upstream event/message schemas. Database owners remain authoritative;
  no second persistence format, execution state machine, or event log.
- Pure projection serves snapshots/live events. Part IDs identify messages;
  call IDs/child links stay stable. Session policy owns history visibility.
  `messageInfo` projects User.model/workspaceId, Assistant completion and path.cwd as workspaceRoot;
  delegate User headers remain private to their own Session.
- Derive deltas from committed previous/next facts. Normal streaming/progress
  never replace transcript snapshots; historical replacement may. User inputs
  append as user-role text events to their own Session: `content` is bubble
  text, structure stays in `metadata.parts`, identical to the history projection.
- `adapter.ts` reads through Session.Service, without SQL or transactions.
  Publish inside the writer's Events barrier; never reacquire it, detach reads,
  lock Permission, or wait for clients/model/approval.
- `publishSnapshot` reads canonical state under the same barrier. After SSE ready,
  waiting observers accept their first Session snapshot; live observers ignore
  later ones. Reconnect requests a fresh snapshot; disconnect never cancels execution.
- Snapshots/replacements use the latest complete-turn page and matching
  `state.history.nextCursor`. `readTranscriptPage` returns older page data without
  publication or Run state. Every read is one page: delegate trees and ancestors
  read each Session's latest page, never a whole transcript.
- Delegate attribution uses persisted links. Keep child inputs private; detach
  each observer's payloads. Permission owns its view.
- Claim/terminal transitions own Run events; terminal delivery follows
  transcript cleanup. Cancel stops the current Run, then wakes queued work.
- Validate cold/live convergence with the community reducer and real HTTP/SSE.
