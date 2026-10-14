# AG-UI lifecycle protocol

Computer-use screenshots use the existing `openchart.tool` Activity:
`content.attachments` holds image FileParts and `content.details.computerUse`
holds the provider's display title and optional display-only `screenshot`.
Display-only native frames never enter model history. Each completed capture is
published while the run continues. Cold snapshots and live Activity updates carry
the same attachments and screenshot metadata; clients select frames from this
canonical transcript. No screenshot-specific event or transport is added. See the
[provider contract](../../../../common/models/src/protocol.md#tool-result-delivery).

Successful tool result text is limited to the first 500 characters followed by
`… [truncated]` when longer. Errors and arguments remain complete. Activity details
retain only the UI's `trace` and `computerUse` fields; provider metadata stays
server-side. Attachments, workflow traces and subagent links keep their existing
shape. Cold snapshots and live updates share this projection; stored tool
results and model history remain complete.

The wire lifecycle of the current implementation. IDs and content in the
diagrams are examples; time flows down or to the right. Uppercase names are
native AG-UI events; `agent.*` are application envelopes / tRPC procedures.

## 0. Overview

```text
                          COMMANDS (HTTP / tRPC)
Client ------------------------------------------------------------> Server
       agent.prompt / agent.cancel / agent.replyPermission
       agent.requestSnapshot({sessionID})

                          OBSERVATION (one shared SSE connection)
Client <------------------------------------------------------------ Server
       events.subscribe
         |
         +-- {kind: "ready"}                 observer registered
         |
         +-- {kind: "event", event: envelope}
                                   |
                                   +-- agent.snapshot  {sessionID, events[]}
                                   +-- agent.event     {sessionID, event}
                                   +-- Resource / other application events

Domain owners                 Protocol adapter              Consumer
---------------------         ---------------------         ----------------
Message / Part in DB ----+
Session / Run in DB -----+---> Publisher ------------------> AG-UI reducer
Permission pending -----+       agui/ -> Events -> SSE         |
                                                            +-- messages[]
                                                            +-- state
```

```text
Session S                         AG-UI identity
|
+-- Run R1                        threadId = S, runId = R1
|   +-- User U1                    native user message.id = U1
|   +-- Assistant A1
|   |   +-- reasoning Part P1      native reasoning message.id = P1
|   |   +-- text Part P2           native assistant message.id = P2
|   |   +-- tool Part P3           parentMessageId = P3
|   |       +-- call C1            toolCallId = C1
|   |       +-- result             message.id = P3:result
|   |       +-- activity           message.id = P3:activity
|   +-- Assistant A2               model continuation, still R1
|
+-- Run R2                        next submitted intent

state
  +-- session                     title, anchors, ...
  +-- runs[]                      durable status; prompt input omitted
  +-- permissions[]               pending requests in this runtime
  +-- history.nextCursor          older complete turns, null at the beginning
  +-- messageInfo[A1 / A2]         workspaceRoot (Assistant.path.cwd), completedAt, error, finish, cost, tokens
  +-- messageInfo[U1 / U2]         model, workspaceId (existing User fields; own Session only)

User U1
  -> content: bubble text only
  -> metadata.parts: text / file / context / workflow Parts (attachments,
     quotes, Dig In and workflows render from here)

Text / reasoning / tool call / result
  -> metadata.openchart.{messageId, partId, createdAt}
                         |          |
                         |          +-- domain Part ID
                         +------------- domain Message ID
     (a tool call carries this on the call itself, toolCalls[].metadata,
      which is where TOOL_CALL_START metadata lands in the reducer)
```

Grouping Messages under a Run shows execution relationships; Parts do not
persist the Run ID. Content keeps its interleaved order by Part, and completion
info is updated by domain Message ID.

Compaction Assistants additionally project
`messageInfo[id].compaction = { userMessageId, summary }`, directly from their
trigger and durable summary seal. The client associates these with the User's
CompactionPart, hides internal summary output, and renders one boundary there.
Unsealed active attempts show `Compacting…`; only sealed summaries show
`Context compacted`. This uses the same STATE_DELTA on completion and the same
headers on reconnect, without a separate compaction state store.

## 1. Normal chat: thinking -> text -> tool -> continued answer

The observer has already applied the initial snapshot. Unrelated Session updates
are omitted; tool details are in the next section.

```text
Client command              Domain action                  Native events -> client
----------------------      ---------------------------    ------------------------
agent.prompt(S, intent) ---> enqueue R1                     STATE_DELTA /runs [queued]
<-- accepted R1              |
                             | claim R1                     RUN_STARTED(S, R1)
                             |                              STATE_DELTA /runs [running]
                             |
                             | commit complete User U1      STATE_DELTA /messageInfo/U1
                             |                              TEXT_MESSAGE_START(U1, role=user,
                             |                                metadata.parts)
                             |                              TEXT_MESSAGE_CONTENT(U1)
                             |                              TEXT_MESSAGE_END(U1)
                             |
                             | create Assistant A1          STATE_DELTA /messageInfo/A1
                             | start step                   STEP_STARTED(A1)
                             |
                             | reasoning P1                 REASONING_START(P1)
                             |                              REASONING_MESSAGE_START(P1)
                             |                              REASONING_MESSAGE_CONTENT
                             |                                delta="Need to call Echo."
                             |                              REASONING_MESSAGE_END(P1)
                             |                              REASONING_END(P1)
                             |
                             | text P2                      TEXT_MESSAGE_START(P2)
                             |                              TEXT_MESSAGE_CONTENT
                             |                                delta="Let me check."
                             |                              TEXT_MESSAGE_END(P2)
                             |
                             | tool P3 / call C1             TOOL_CALL_START(C1, parent=P3)
                             |                              ACTIVITY_SNAPSHOT(P3:activity)
                             |                              TOOL_CALL_ARGS(C1, full JSON)
                             |                              TOOL_CALL_END(C1)
                             | execute tool                 ACTIVITY_DELTA(P3:activity)
                             |                              TOOL_CALL_RESULT(P3:result, C1)
                             |                              ACTIVITY_DELTA(P3:activity)
                             |
                             | finish step                  STEP_FINISHED(A1, usage/cost)
                             |                              STATE_DELTA /messageInfo/A1
                             |
                             | Prompt rereads transcript
                             | -> another model request
                             |
                             | create Assistant A2          STATE_DELTA /messageInfo/A2
                             | start step                   STEP_STARTED(A2)
                             | text P4                      TEXT_MESSAGE_START(P4)
                             |                              TEXT_MESSAGE_CONTENT("Here...")
                             |                              TEXT_MESSAGE_CONTENT("...done.")
                             |                              TEXT_MESSAGE_END(P4)
                             | finish step                  STEP_FINISHED(A2, usage/cost)
                             |                              STATE_DELTA /messageInfo/A2
                             |
                             | Prompt returns; cleanup done
                             | complete R1                  STATE_DELTA /runs [completed]
                             |                              RUN_FINISHED(S, R1)
                             |
SSE stays open <-------------+----------------------------- next Run can use this stream
```

```text
Session observation  =======================================================>
Durable Run R1           [ RUN_STARTED ---------------------- RUN_FINISHED ]
Model requests             [ A1: thinking + text + tool ] [ A2: answer ]
Native step                [ STEP_STARTED ... FINISHED  ] [ START ... FINISHED ]

One claim -> one RUN_STARTED. Model continuation stays inside that Run.
HTTP admission receipt and SSE delivery travel independently.
```

Implementation: [events.ts](events.ts), [adapter.ts](adapter.ts),
[projection.ts](projection.ts).

## 2. Tools: arguments end -> execution / progress -> result

Task and provider subagents both keep the parent tool call and additionally use
native subagent events:

The persisted relationship is always `ToolPart.childSessionIds`, which holds
every child Session the tool calls directly; repeated calls to the same Session
are recorded once. The relationship set defines neither display nor the child
invocation lifecycle. A single Task/provider child invocation projects to the
native events below and the Activity `childSessionId`; a workflow keeps
projecting a trace even with only one child Session, and creates no native
subagent card.

```text
Parent Session S / proxy Part P, call C
  TOOL_CALL_START(C) -> ARGS -> END
  ACTIVITY_DELTA(P:activity, childSessionId=child)
  SUBAGENT_STARTED(subagentRunId=P, parentToolCallId=C, parentMessageId=P)
    STEP_STARTED(child Assistant, subagentRunId=P)
    TEXT / REASONING / TOOL events (subagentRunId=P)
    STEP_FINISHED(child Assistant, subagentRunId=P)
    ... additional child steps, if needed ...
  SUBAGENT_FINISHED(P)                 entire invocation completed after child cleanup
  TOOL_CALL_RESULT(C)                  parent proxy result

Nested child Q: SUBAGENT_STARTED(Q, parentSubagentRunId=P, ...)
Interrupted child: parent proxy error -> SUBAGENT_ERROR(P)
```

Each invocation keeps the nesting order
`TC < subagent start < subagent end < TR`: the parent tool call wraps the whole
child invocation. On failure, `SUBAGENT_ERROR` closes the inner level, then the
parent tool's error result is published. Both the end event and the result are
projected from the same committed terminal state of the parent ToolPart; one
completed child Assistant turn does not end the whole invocation. Concurrent
invocations may interleave; each keeps this order, and no global stack order is
required.

Child content stays persisted separately in the child Session and carries native
attribution in ancestor observation streams. Each invocation keeps its own
message order; concurrent invocations may interleave. Child inputs are shown only
in the separate child Session; Session and Run state keep their own scope.
Permission separately aggregates approval requests for each observed Session and
its delegated descendants, keeps each request's original attribution, and does
not depend on ToolPart links. A Snapshot includes the attribution of all linked
child messages, each child invocation's native start/terminal event, and the
start of Parts still producing output. See [subagents.ts](subagents.ts) and
[AG-UI Subagents](https://docs.ag-ui.com/concepts/subagents).

```text
Committed ToolPart       Native events                       Client view
----------------------   ---------------------------------   ----------------------
(absent)
   |
   v
pending                  TOOL_CALL_START(C1, parent=P3)       tool card exists
                         ACTIVITY_SNAPSHOT(P3:activity)       status=pending
   |
   | input committed
   v
running                  TOOL_CALL_ARGS(C1, '{"text":"hi"}')  complete argument JSON
                         TOOL_CALL_END(C1)                   argument stream closed
                         ACTIVITY_DELTA(P3:activity)          status=running
   |
   | progress            ACTIVITY_DELTA(P3:activity)          details / title
   | progress            ACTIVITY_DELTA(P3:activity)          attachments / childSessionId
   |
   +--> completed        TOOL_CALL_RESULT                    output
   |                       messageId=P3:result
   |                       toolCallId=C1
   |                       content="echo hi"
   |                     ACTIVITY_DELTA(P3:activity)          status=completed
   |
   +--> error            TOOL_CALL_RESULT                    tool error
                           messageId=P3:result
                           toolCallId=C1
                           content="...", error="..."
                         ACTIVITY_DELTA(P3:activity)          status=error

TOOL_CALL_END ----------- arguments are complete
TOOL_CALL_RESULT -------- execution has a terminal result
RUN_FINISHED / ERROR ---- the durable Run has ended
```

Arguments come from the committed complete input; SDK argument fragments are not
forwarded token by token. The pinned-version
[core/client patch](../../../../patches/README.md) keeps the `error` field. A
tool failure is not itself a Run failure; Prompt decides whether to continue.

```text
Parallel tools (one possible interleaving)

Call C1    START -> ARGS -> END -------- progress -------- RESULT
Call C2         START -> ARGS -> END ---- RESULT
                       |                    |
                       +--- executions may overlap -----+

Wire       [commit + publish C1] [commit + publish C2] [C2 result] [C1 result]
Pairing    call ID, not arrival adjacency
Progress   P3:activity, not repeated TOOL_CALL_RESULT
```

Implementation: [projection.ts](projection.ts), [activity.ts](activity.ts).

## 3. First catch-up: joining a running Session midway

Here a new observer joins an existing Session. Cold start and live join both use
the snapshot request and handoff below.

```text
New observer                Shared SSE / router               Agent / DB
-----------------------     -------------------------------   ----------------------
events.subscribe ---------> register listener
<-------------------------- {kind: "ready"}
                            |
agent.requestSnapshot({S}) -+--------------------------------> acquire Events barrier
                            |                                 read canonical snapshot
                            |                                 publish agent.snapshot
<--------------------------+--------------------------------- release barrier
  agent.snapshot {
    sessionID: S,
    events: [
      MESSAGES_SNAPSHOT,       // latest configured complete turns, including partial content
      STATE_SNAPSHOT,          // session, runs, permissions, messageInfo, history
      ...open Part starts      // no old CONTENT or ARGS replay
    ]
  }
  |
  +-- apply events in array order
  +-- observer becomes LIVE
                            |
<-------------------------- agent.event {S, TEXT_MESSAGE_CONTENT(delta=" world")}
<-------------------------- agent.event {S, TEXT_MESSAGE_END}
<-------------------------- agent.event {S, STATE_DELTA ...}
```

The snapshot is delivered over SSE; the HTTP response of the `requestSnapshot`
mutation does not carry it.

### Complete-turn pagination

`agent.readTranscriptPage({sessionID, cursor?, turnLimit?})` is a read-only HTTP
query. `turnLimit` is any positive safe integer; its default is configured in one
place by `DEFAULT_HISTORY_TURN_LIMIT`, currently 1. Without a cursor, it reads
the latest page. Response:

```ts
{
  (messages, messageInfo, lifecycle, open, nextCursor);
}
```

A page holds 1–N complete turns: from one User up to the next User, including
every Assistant, Part, tool call/result, and linked delegate output in the page.
A running last turn includes everything up to the time of the read. An empty
history returns an empty page and a null cursor. A turn is never split, however
large, and pages are never truncated by bytes, Parts, or Message count. An
existing Assistant prefix with no User belongs to the oldest page.

Every transcript read, for any reason, is the same paged read; there is no "read
the whole transcript" entry point. Each delegate in the tree also reads only its
latest page: task creates a new delegate every time, so that page is usually all
of it. Only auto compaction adds a new turn to a delegate, after which the card
shows only the output after compaction. Ancestor resolution likewise looks only
at the parent Session's latest page, and a delegate is published only while its
parent turn is open.

Within a page, items are in chronological order. Paging back uses the returned
opaque `nextCursor`; null means there is nothing earlier. The cursor binds the
Session and the oldest User's SQL `(createdAt, id)`, not an offset. New content
at the tail does not move old page boundaries, and the cursor still works after
a boundary message is deleted. Dig In excludes hidden history before its marker
when SQL selects the page; later pages need not carry the marker again. Model
reads still use the full history.

The first snapshot, reconnects, and history replacements all return the
configured number of latest complete turns. The matching cursor is sent with
`STATE_SNAPSHOT.history` or `STATE_DELTA /history` respectively, and always
matches the `MESSAGES_SNAPSHOT` in the same batch. A complete User write appends
rather than replaces: only its own Session receives
`TEXT_MESSAGE_START/CONTENT/END` with `role: "user"`. `content` is the bubble
text, and structure such as attachments, quotes, Dig In, and workflows goes in
the START `metadata.parts`, exactly like the history page projection, so already
loaded old pages stay valid. Ordinary tokens and tool progress still use deltas.
Old pages reuse the same AG-UI projection. `lifecycle`/`open` are page
description data with no Run state, and history events are never replayed over
SSE. The query and snapshots are both read inside the existing Events barrier.

Frontend integration rules: page back starting from the snapshot's
`state.history.nextCursor`, merge page content and messageInfo by stable ID, and
use lifecycle to restore child cards; never treat an old page as a
`MESSAGES_SNAPSHOT` that overwrites the streaming tail. On a replacement snapshot
or reconnect, reset history pagination, drop any in-flight page responses, and
start again from the new cursor. The shared SessionStore uses TanStack Query's
InfiniteQueryObserver to manage old pages, requests, retries, and cancellation,
then combines them with the AG-UI live tail into a single transcript. Every
Session reuses AgentThread/AgentLayout: scrolling up loads more pages
automatically, failures can be retried, and inserting old messages keeps the
currently visible messages in place. There are no separate display branches per
feature or Session kind.

```text
At snapshot time                 Snapshot native events            Subsequent live
------------------------------   -------------------------------   --------------------
text P1 = "Hello", still open     MESSAGES_SNAPSHOT(P1="Hello")      CONTENT(P1," world")
                                 TEXT_MESSAGE_START(P1)            END(P1)
                                 ^ preserves existing content

reasoning P2, still open          snapshot contains P2              CONTENT(P2, suffix)
                                 REASONING_START(P2)               MESSAGE_END(P2)
                                 REASONING_MESSAGE_START(P2)       REASONING_END(P2)

tool C1 = pending                snapshot contains call + activity ARGS(C1, full JSON)
                                 TOOL_CALL_START(C1)               END(C1), activity...

tool C2 = running                snapshot contains args + activity activity..., RESULT
                                 (no TOOL_CALL_START / ARGS / END)

closed Part / completed Message  snapshot only                     (no reopen)

Run R1 already running           STATE_SNAPSHOT.runs[R1]=running
                                 (no synthetic RUN_STARTED)

Session currently idle           MESSAGES_SNAPSHOT + STATE_SNAPSHOT
                                 (no synthetic Run)
```

In the table, `REASONING_MESSAGE_CONTENT/END` is abbreviated as
`CONTENT/MESSAGE_END`. Long-lived Sessions use the community reducer extension
points; the first event of a subscription cannot be required to be
`RUN_STARTED`.

### Handoff between snapshot and delta

```text
Server: every [block] holds the SAME Events barrier

time ------------------------------------------------------------------------>
       [ Writer A                 ] [ Snapshot S        ] [ Writer B          ]
       [ write -> commit -> publish] [ read -> publish   ] [ write -> commit   ]
                                    [                   ] [ -> publish        ]

Bus:        event A ----------------> snapshot S -----------> event B ---------->
Observer:   WAITING                   apply once; LIVE        apply
            ignore A                 snapshot includes A

                         No writer can cross this cut
                                     |
                facts in snapshot <--+--> changes delivered after snapshot

Forbidden:  commit A -> snapshot includes A -> publish delta A
                                              ^ would apply A twice
```

No client delta buffer is needed; facts ignored while waiting are already in the
snapshot. The barrier wraps only write / snapshot / publish, never model calls or
waits for user approval.

Implementation: [adapter.ts](adapter.ts), [commit.ts](../../session/commit.ts),
[client.ts](../../../../app/src/lib/agent/client.ts).

## 4. Disconnect, reconnect, close and reopen

```text
Observer state

DETACHED -- subscribe --> WAITING -- first snapshot(S) ---> LIVE
                            |                                |
                            | agent.event(S): ignore         | agent.event(S): apply
                            |                                | snapshot(S): ignore
                            |                                |
                            +<---- disconnect / connecting --+
                            |
                            +-- ready -> requestSnapshot(S) again

WAITING / LIVE -- last local listener unsubscribes --> DETACHED
```

```text
Client cached text       Network                 Backend text / Run
----------------------   ---------------------   ----------------------------
"Hello"                  LIVE                    "Hello" / running
                         X connection lost
"Hello"                  disconnected            "Hello world" / running
                                                 "Hello world!" / completed
                         reconnect -> ready
                         requestSnapshot(S)
"Hello world!"   <------ MESSAGES_SNAPSHOT        canonical completed history
state=completed  <------ STATE_SNAPSHOT
                         no open Parts
                         LIVE, waiting for next Run

Gap events: not replayed. Current state: recovered from authoritative owners.
SSE disconnect / view detach: backend Run continues.
Process restart / crashed Run recovery: not implemented by this protocol.
```

```text
Slow subscriber
  server connection queue (capacity 256)
    -> overflow -> explicit stream failure
    -> new subscription + ready + requestSnapshot required

Native RUN_ERROR              transport / snapshot request error
  one Run ends                  observation fails / must recover
  Session stream stays open     does not itself cancel the Run
```

Implementation: [events/router.ts](../../../events/router.ts),
[events.ts](../../../events/events.ts),
[client.ts](../../../../app/src/lib/agent/client.ts).

## 5. Multiple observers: shared connection and shared snapshots

One `createAgentClient` shares one SSE connection; different clients each have
their own connection, and snapshots are broadcast on the current bus.

```text
                          one shared connection
Observer A (Session S) ---+
Observer B (Session S) ---+---- events.subscribe ---- Server bus
Observer C (Session T) ---+
Resource observer -------+

Incoming envelope              A: WAITING     B: WAITING     C: WAITING(T)
---------------------------    ------------   ------------   -------------
agent.snapshot(S), asked by A   apply -> LIVE  apply -> LIVE  ignore
agent.event(S, delta)           apply          apply          ignore
agent.snapshot(S), asked by B   ignore         ignore         ignore
agent.snapshot(T)               ignore         ignore         apply -> LIVE

Late observer D(S): joins stream -> calls requestSnapshot(S)
  A / B already LIVE: ignore it
  D still WAITING:    apply it
```

```text
Delayed request around reconnect

HTTP request #1 --------------------------> executes after reconnect
SSE connection #1 -------- X
SSE connection #2 -------- ready ---------> receives snapshot(S) from #1
HTTP request #2 -------------------------------> later snapshot(S)
Observer                 WAITING           LIVE  ignore duplicate

Matching key = sessionID. First matching snapshot wins, whoever requested it.

Pending HTTP snapshot request failure
  still WAITING ---------------------> fail this observer only
  already got matching snapshot -----> ignore old request failure
  disconnected / detached ----------> ignore old request failure

Last observer of a Session leaves -> detach that Session
Last observer of shared SSE leaves -> close connection
Neither action cancels backend execution.
```

Implementation and scenario tests:
[client.ts](../../../../app/src/lib/agent/client.ts),
[router.snapshot.test.ts](../../router.snapshot.test.ts).

## 6. Approvals: the Run keeps running while the tool waits for a reply

Example with a single tool awaiting approval. `permissions` is always the
complete pending set for the Session and its delegated descendants. Live updates
and Snapshots share `Permission.list(sessionID)`. A child request keeps its
`sessionID` and requestID; the parent Session UI replies to the original request
through the same `replyPermission` interface. Requests from concurrent child
tasks are aggregated together; ordinary branches are not delegated descendants.
Display needs no tool card or child Session subscription.

```text
Tool / Permission owner       Native state / events              Client
--------------------------    -------------------------------    -------------------
Run R1 running
tool enters execution         TOOL_CALL_ARGS -> TOOL_CALL_END
                              ACTIVITY_DELTA(status=running)
ask -> register request Q     STATE_DELTA /permissions [Q] ------> show approval
   |
   | WAIT (no barrier held)   runs[R1].status = running
   |                          no RUN_FINISHED / new RUN_STARTED
   |
   |                          late observer snapshot ----------> same pending Q
   |
   +<----------------------------------------------------------- replyPermission
   |                                                             {requestID: Q,
   |                                                              reply: "once"}
   |
remove Q                      STATE_DELTA /permissions []
resume tool
complete                      TOOL_CALL_RESULT + ACTIVITY_DELTA
Prompt continues              ... answer ...
Run completes                 STATE_DELTA /runs -> RUN_FINISHED
```

```text
Reply / interruption           Owner behavior
----------------------------   -------------------------------------------------
once                           release this request
always                         save provided allow patterns, release request;
                               may also release other matching pending requests
reject, no feedback            decline -> abort execution -> cleanup -> RUN_ERROR
reject, with feedback          CorrectedError -> caller handles tool failure
agent.cancel(S)                 interrupt wait -> remove pending -> cleanup

reject also rejects other pending requests in the same Session.
Pending approvals are process-local; saved grants are persisted.
```

Implementation: [permission.ts](../../permission/permission.ts),
[events.ts](events.ts). Delegated approval integration test:
[router.permissions.test.ts](../../router.permissions.test.ts).

## 7. Failure / cancel: clean up first, then end the Run; the next queued request continues

```text
Normal success            Model failure / interruption
-----------------------   ---------------------------------------------------
finish open output        interrupt / fail active request
finish step               cleanup unfinished transcript (as applicable):
                          +-- TEXT_MESSAGE_END
                          +-- REASONING_MESSAGE_END -> REASONING_END
                          +-- TOOL_CALL_RESULT(error) + ACTIVITY_DELTA
                          +-- STATE_DELTA /messageInfo/<id>
                          |     completedAt, error, ...
                          +-- pending permissions removed
   |                         |
   v                         v
Prompt returns            failure / interruption reaches Runner
Run -> completed          Run -> failed / stop (pure interruption after cleanup)
STATE_DELTA /runs         STATE_DELTA /runs
RUN_FINISHED(S, R)        failed: RUN_ERROR(code="RUN_FAILED")
                         stop: RUN_FINISHED(S, R)

RUN_ERROR.message = "Run failed or was interrupted; see the transcript."
Detailed Assistant error -> state.messageInfo[domainMessageID].error
Partial transcript stays visible.
STEP_FINISHED comes from an actual finish-step; failure cleanup does not invent it.
```

The cleanup box only lists work that must finish before the terminal state; it
does not set the relative order of cleanup across different tools / approvals.

```text
One Session, two accepted intents

R1      queued -> RUN_STARTED -------- running -------- RUN_FINISHED (stop)
R2                           enqueue -> queued -----------------> RUN_STARTED ...
Client                                  agent.cancel(S) --+
                                                        |
Server     interrupt current R1 -> await cleanup -> stop R1 -> wake Session
                                                               |
                                                               +--> claim R2

Cancel targets current execution. Accepted queued Runs remain in the queue.
Same Session: serial Runs. Different Sessions: may run concurrently.
```

Implementation: [router.ts](../../router.ts),
[processor.ts](../../processor/processor.ts), [events.ts](events.ts).

## 8. Snapshot: the boundary between replacing the history window and everyday deltas

```text
Cause                                    Wire
--------------------------------------   -------------------------------------------
First attach / reconnect                 agent.snapshot  [MESSAGES_SNAPSHOT,
                                                          STATE_SNAPSHOT, starts...]
Complete User input committed            STATE_DELTA /messageInfo/<id> + TEXT_MESSAGE_START
                                         (role=user, metadata.parts) -> CONTENT -> END
Actual historical content replacement    MESSAGES_SNAPSHOT + STATE_DELTA /messageInfo, /history
Append text / reasoning                  *_CONTENT(delta) -> *_END
Tool progress / display details          ACTIVITY_SNAPSHOT -> ACTIVITY_DELTA
Tool terminal result                     TOOL_CALL_RESULT + ACTIVITY_DELTA
Assistant completion / usage / error     STATE_DELTA /messageInfo/<id>
Session title / anchors                  STATE_DELTA /session
Run status / pending approvals           STATE_DELTA /runs or /permissions
Internal bookkeeping, no visible change  (no event)
```

```text
Text whitespace example (same rule for reasoning)

DB Part text       "Hello "     -> "Hello world  "     -> "Hello world" (end)
Wire               "Hello"        delta=" world"         TEXT_MESSAGE_END
Reducer content    "Hello"     -> "Hello world"        -> "Hello world"

Published text = committed text.trimEnd(); final trimming needs no snapshot.

Historical replacement example
  old="Hello" -> new="Hi"   cannot be represented by an append delta
  -> close newly ended Part, if applicable
  -> publish authoritative messages snapshot + matching messageInfo
  Future history editing uses this path; an editing API is not implemented.
```

```text
After a gap, full history replaces cached messages (including order/deletions)

Cache before gap:   [ User, tool call, activity, answer ]
Snapshot from DB:   [ User, tool call, RESULT, activity, answer ]
                              |
                              v
onMessagesSnapshotEvent -> messages = snapshot.messages
                          stopPropagation = true

No cached-order merge. Subsequent deltas use the native AG-UI reducer.

                    Same committed point
                   /                    \
        DB history + public state    snapshot at T + later native events
                   |                    |
           canonical projection         reducer
                   |                    |
                   +------ equal -------+
                         messages/state
```

Implementation: [adapter.ts](adapter.ts), [projection.ts](projection.ts),
[session-store.ts](../../../../app/src/lib/agent/session-store.ts).

## 9. Implementation and test map

| Diagram / behavior                                                                | Verification                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Normal tools, next turn, errors, approvals, cancel, queueing, disconnect recovery | [router.sse.test.ts](../../router.sse.test.ts)                                         |
| ready, snapshot handoff, multiple observers, delayed snapshot, failure isolation  | [router.snapshot.test.ts](../../router.snapshot.test.ts)                               |
| Part ID, tool result / activity, trim, reopening unfinished Parts                 | [projection.test.ts](projection.test.ts)                                               |
| Committed deltas, normal finish, error / cancel cleanup, delegate order           | [processor-events.test.ts](../../processor/processor-events.test.ts)                   |
| Client cache replacement and observation lifecycle                                | [session-store.test.ts](../../../../app/src/lib/agent/__tests__/session-store.test.ts) |

Architecture and owner boundaries: [Agent](../../../../docs/architecture/agent.md),
[this directory's constraints](AGENTS.md).
