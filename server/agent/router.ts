import { Question } from "@openchart/server/agent/question";
// Purpose: Admits canonical agent prompts through the V2 tRPC boundary.
import { trpc } from "@openchart/server/lib/trpc";
import { Effect, Schema } from "effect";
import { Session as SessionInfo } from "@openchart/server/agent/contracts/session";
import { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Session } from "@openchart/server/agent/session";
import { OrderBy } from "./session/store";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { DigInInput } from "@openchart/server/agent/session/operations/dig-in";
import { TruncateInput } from "@openchart/server/agent/session/operations/truncate";
import {
  PromptRequest,
  submitPrompt,
} from "@openchart/server/agent/session/submit-prompt";
import { Permission } from "@openchart/server/agent/permission";
import { linkPreviewRouter } from "./link-preview/router";
import { publishSnapshot, bootstrapSessions } from "./publisher/agui/adapter";
import { readHistoryPage } from "./publisher/agui/history";
import { TranscriptPageInput } from "./session/operations/read-transcript-page";
import { MarkReadInput } from "./session/operations/mark-read";
import { Events } from "@openchart/server/events";
import { projectRun } from "./session/state";
import {
  BuildCommandRequest,
  buildCommand,
  listCommands,
  restoreCommand,
} from "./command/command";

const DEFAULT_SESSION_LIST_LIMIT = 15;

/**
 * Agent transport adapter containing durable prompt admission.
 *
 * The mutation returns after the run is durable. Execution continues through
 * `SessionExecution`, so the response is the accepted queued snapshot rather
 * than a synchronous prompt result.
 */
export const agentRouter = trpc.router({
  linkPreview: linkPreviewRouter,
  commands: trpc.procedure.query(() => listCommands()),
  buildCommand: trpc.procedure
    .input(Schema.toStandardSchemaV1(BuildCommandRequest))
    .mutation(({ ctx, input }) => ctx.runtime.runPromise(buildCommand(input))),
  restoreCommand: trpc.procedure
    .input(Schema.toStandardSchemaV1(AgentPromptPartInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(restoreCommand(input)),
    ),
  truncateSession: trpc.procedure
    .input(Schema.toStandardSchemaV1(TruncateInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.truncate(input)),
      ),
    ),
  digInSession: trpc.procedure
    .input(Schema.toStandardSchemaV1(DigInInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.digIn(input)),
      ),
    ),
  forkSession: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: SessionInfo.fields.id,
          messageID: Schema.String.check(Schema.isMinLength(1)),
        }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.fork(input)),
      ),
    ),
  getSessionByBinding: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          key: Schema.String.check(Schema.isMinLength(1)),
        }),
      ),
    )
    .query(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.getSessionByBinding(input)),
      ),
    ),
  getOrCreateBoundSession: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          key: Schema.String.check(Schema.isMinLength(1)),
          kind: SessionInfo.fields.kind,
          title: Schema.optionalKey(Schema.String),
        }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.getOrCreateBound(input)),
      ),
    ),
  createSession: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.create(input)),
      ),
    ),
  renameSession: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: SessionInfo.fields.id,
          title: SessionInfo.fields.title,
        }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) =>
          session.update(input.sessionID, { title: input.title }),
        ),
      ),
    ),
  /** Archives metadata without deleting history or stopping execution. */
  archiveSession: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: SessionInfo.fields.id }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.archive(input.sessionID)),
      ),
    ),
  markSessionRead: trpc.procedure
    .input(Schema.toStandardSchemaV1(MarkReadInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) => session.markRead(input)),
      ),
    ),
  listSessions: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          limit: Schema.optionalKey(
            Schema.Int.check(
              Schema.isGreaterThan(0),
              Schema.isLessThanOrEqualTo(100),
            ),
          ),
          cursor: Schema.optionalKey(Schema.String),
          orderBy: Schema.optionalKey(OrderBy),
        }),
      ),
    )
    .query(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Session.Service.use((session) =>
          session.list({
            ...input,
            kinds: ["chat"],
            parentId: null,
            excludeArchived: true,
            orderBy: input.orderBy ?? "updatedAt",
            limit: input.limit ?? DEFAULT_SESSION_LIST_LIMIT,
          }),
        ),
      ),
    ),
  bootstrapSessions: trpc.procedure.mutation(({ ctx }) =>
    ctx.runtime.runPromise(bootstrapSessions(DEFAULT_SESSION_LIST_LIMIT)),
  ),
  /** Older complete turns in AG-UI format; the first page is also available without a cursor. */
  readTranscriptPage: trpc.procedure
    .input(Schema.toStandardSchemaV1(TranscriptPageInput))
    .query(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Events.Service.use((events) =>
          events.withBarrier(readHistoryPage(input)),
        ),
      ),
    ),
  /**
   * Guarantees a snapshot-to-live handoff with no missing or duplicated state
   * changes: earlier changes are included in the snapshot; later changes arrive
   * as ordered live events on the same subscription.
   *
   * Every Agent writer must hold the same Events barrier across mutation,
   * commit, and publication. Snapshot publication holds it across reading and
   * publication. A committed change must never appear in the snapshot while
   * its corresponding event is still waiting to be published after the snapshot.
   *
   * The client must subscribe first, ignore pre-snapshot deltas, apply the
   * first snapshot for this Session once, then consume live events and ignore
   * later snapshots. Disconnect or overflow requires a fresh snapshot;
   * this guarantees the state handoff, not durable event replay across reconnects.
   *
   * ```text
   * Server: one shared barrier. Each [block] holds it from start to finish.
   *
   *   time ---------------------------------------------------------->
   *        [ Writer A ] ---> [ Snapshot S ] ---> [ Writer B ]
   *
   *   Writer A/B:  write -> commit -> publish, then release the barrier.
   *   Snapshot S: read snapshot -> publish, then release the barrier.
   *
   * Client: events.subscribe ready -> call requestSnapshot.
   *   event A ------> snapshot S ------> event B ------> later snapshot
   *   ignore          apply once        apply          ignore
   *                   includes A
   *
   * Disconnect / overflow -> subscribe ready -> requestSnapshot again (no replay).
   * ```
   * @example
   * await client.agent.requestSnapshot.mutate({sessionID});
   */
  requestSnapshot: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: SessionInfo.fields.id,
        }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(publishSnapshot(input.sessionID)),
    ),
  // Stop the current Run, then let already accepted queued intents continue.
  cancel: trpc.procedure
    .input(
      Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: SessionInfo.fields.id }),
      ),
    )
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        SessionExecution.Service.use((execution) =>
          execution
            .interrupt(input.sessionID)
            .pipe(Effect.andThen(execution.wake(input.sessionID))),
        ),
      ),
    ),
  replyQuestion: trpc.procedure
    .input(Schema.toStandardSchemaV1(Question.ReplyInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Question.Service.use((question) => question.reply(input)),
      ),
    ),
  replyPermission: trpc.procedure
    .input(Schema.toStandardSchemaV1(Permission.ReplyInput))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(
        Permission.Service.use((permission) => permission.reply(input)),
      ),
    ),
  prompt: trpc.procedure
    .input(Schema.toStandardSchemaV1(PromptRequest))
    .mutation(({ ctx, input }) =>
      ctx.runtime.runPromise(submitPrompt(input).pipe(Effect.map(projectRun))),
    ),
});
