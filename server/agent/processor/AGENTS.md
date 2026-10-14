# processor

Owns Assistant projection and cleanup, including delegates.
Prompt grants exclusive access to an empty, unfinished Assistant.

- `create` produces a per-Assistant instance; `process` runs once, returns void,
  and propagates failures after cleanup. Prompt alone decides continuation.
  Keep Parts/waiters private; no second state machine.
- Commit the running ToolPart before entering its callback. Waiting for missing
  input must not suspend the idle deadline. Interrupt unresolved waiters on exit.
- One semaphore serializes events, progress, and cleanup. Close admission before
  cleanup writes; late progress cannot reopen terminal tools. Preserve child links
  and merge final metadata over committed progress.
- Destinations own step lifecycle: root may have multiple steps, children one.
  Children finish before parent proxies; proxy output is never child content.
- Empty deltas refresh idle; publish only committed content/metadata changes.
  Step completion atomically saves usage/marker, rejecting active Parts;
  exhaustion requires finished steps.
- Effect owns retry, idle deadlines, and cancellation. Disable SDK retries; never
  retry after projection or execution starts. Busy execution suspends provider
  silence timing; downstream writes do not count.
- Attempt all cleanup writes and combine failures with the original Cause.
  Release waiters despite storage failures; complete children before parents,
  with root completion last. Preserve already-completed outcomes.
