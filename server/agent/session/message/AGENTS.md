# message

Owns transcript persistence/projection; Session operations expose data actions.

- Stores use caller transactions; live writes use Session's commit boundary.
  SQL owns identity/ownership/role; `data.ts` derives JSON from shared contracts.
  Parse reconstructed writes. Parts reference Messages only; reject duplicate
  inserts, missing updates, invalid state, and changed identity/ownership/discriminants.
- Startup repair closes active Parts before unfinished Assistants, preserving
  content/errors on retries.
- Page whole Messages by SQL creation time/ID descending, optionally centered
  via `around` or bounded inclusively by `throughCreatedAt`. Pages return
  oldest-first with Parts in ID order; complete history restores global order.
  Content timestamps are separate; cursors retain Session scope.
- Display pages use `listTurns`: user-to-next-user boundaries, complete Parts,
  newest pages with oldest-first contents. Cursors exclude their boundary and
  survive deletion. It reads the Session kind itself; Dig In excludes its copied
  prefix in SQL, before Part reads, and shows nothing before its marker.
- `to-model-messages.ts` projects selected history without reads/execution/mutation.
  Preserve tool pairing, interrupted outcomes, media, provider metadata, and text
  order. Dig-in framing never consumes sibling text.
- `transcript-text.ts` serializes that projection with the recorded model,
  pruning reasoning; nested `read_transcript` outputs become source-Session
  pointers. Reads/search share it; search loads whole messages with evidence.
  `transcriptLike` prefilters stored Part JSON for listing and message matches;
  projected JSON determines relevance.
- `evidence.ts` owns bounded blocks/hashes/serialization; commit before replay
  or returning references. `visibility.ts` owns synthetic text visibility;
  model history retains the context excluded from display pages.
- Persisted shape changes require forward migrations, never request-time repair.
