// Purpose: Owns Agent runtime tables and their durable relational constraints.

import { inArray, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { Schema } from "effect";
import type * as MessageData from "@openchart/server/agent/session/message/data";
import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import type { SessionAnchor } from "@openchart/server/agent/contracts/session-anchor";
import { SessionKind } from "@openchart/server/agent/contracts/session";

const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
// SQL timestamps record row lifecycle in epoch milliseconds. Message/Part
// content timestamps are separate facts, including when inherited by a fork.
const timestamps = {
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
};

/** Feature slot identities shared by current and historical sessions. */
// @agent invariant: A single-user binding slot has one globally unique key.
// Features construct stable keys; Agent storage never interprets their format.
export const agentSessionBindings = sqliteTable(
  "agent_session_bindings",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uniq_agent_session_bindings_key").on(table.key),
    check("chk_agent_session_bindings_key", sql`trim(${table.key}) <> ''`),
  ],
);

/** Sessions, branch ancestry, and current/historical feature bindings. */
// @agent invariant: A binding's current session is the first row ordered by
// createdAt DESC, id DESC. The ID breaks equal-timestamp ties consistently.
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    kind: text("kind", { enum: SessionKind.literals }).notNull(),
    bindingId: text("binding_id").references(() => agentSessionBindings.id, {
      onDelete: "restrict",
    }),
    anchors: text("anchors", { mode: "json" }).$type<SessionAnchor[]>(),
    title: text("title").notNull(),
    compactingAt: integer("compacting_at"),
    archivedAt: integer("archived_at"),
    lastReadRunId: text("last_read_run_id").references(
      (): AnySQLiteColumn => agentRun.id,
      { onDelete: "restrict" },
    ),
    ...timestamps,
  },
  (table) => [
    check(
      "agent_sessions_kind_check",
      inArray(table.kind, SessionKind.literals).inlineParams(),
    ),
    index("idx_agent_sessions_updated").on(table.updatedAt),
    index("idx_agent_sessions_parent").on(table.parentId),
    index("idx_agent_sessions_binding").on(
      table.bindingId,
      table.createdAt,
      table.id,
    ),
  ],
);
/** Message identity and role columns with column-free transcript content. */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    data: text("data", { mode: "json" })
      .$type<MessageData.InfoData>()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    index("idx_agent_messages_session_created").on(
      table.sessionId,
      table.createdAt,
    ),
    index("idx_agent_messages_session_canonical_id").on(
      table.sessionId,
      table.id,
    ),
    check(
      "chk_agent_messages_role",
      sql`${table.role} IN ('user', 'assistant')`,
    ),
    check(
      "chk_agent_messages_data_columns",
      sql`
      json_valid(${table.data}) AND json_type(${table.data}) = 'object'
      AND json_type(${table.data}, '$.id') IS NULL
      AND json_type(${table.data}, '$.sessionID') IS NULL
      AND json_type(${table.data}, '$.role') IS NULL
    `,
    ),
  ],
);
/** Part ownership and column-free variant content. */
export const agentParts = sqliteTable(
  "agent_parts",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    data: text("data", { mode: "json" })
      .$type<MessageData.PartData>()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    index("idx_agent_parts_message").on(table.messageId),
    check(
      "chk_agent_parts_data_columns",
      sql`
      json_valid(${table.data}) AND json_type(${table.data}) = 'object'
      AND json_type(${table.data}, '$.id') IS NULL
      AND json_type(${table.data}, '$.messageID') IS NULL
      AND json_type(${table.data}, '$.sessionID') IS NULL
    `,
    ),
  ],
);
/** Stable per-session todo identities with independently ordered positions. */
export const agentTodos = sqliteTable(
  "agent_todos",
  {
    id: text("id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    position: integer("position").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.id] }),
    uniqueIndex("uniq_agent_todos_position").on(
      table.sessionId,
      table.position,
    ),
  ],
);
/** Durable per-user permission policy. */
export const agentPermissions = sqliteTable("agent_permissions", {
  userId: text("user_id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  ...timestamps,
});
/** Durable lifecycle states for one accepted agent execution intent. */
export const AgentRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "stop",
  "failed",
]);

/** Durable lifecycle state for one accepted agent execution intent. */
export type AgentRunStatus = typeof AgentRunStatus.Type;

/**
 * The single durable queue and lifecycle table for agent execution.
 * Agent claiming a prompt for execution will never delete it, thus
 * this is a durable ledger.
 *
 * @example
 * ```ts
 * const query = database.select().from(agentRun);
 * ```
 */
export const agentRun = sqliteTable(
  "agent_run",
  {
    /**
     * Stable identity of this accepted execution.
     *
     * It identifies the run across queue and lifecycle transitions; session and
     * intent identities remain separate so neither is overloaded as the run ID.
     */
    id: text("id").primaryKey(),
    /**
     * Session whose execution queue owns this run.
     *
     * Runs with the same session ID are claimed in FIFO order and at most one of
     * them may be `running`; different sessions may execute concurrently.
     *
     * The session must exist before admission. Deletion is restricted while
     * its durable execution history exists.
     */
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "restrict" }),
    /**
     * Caller-supplied idempotency identity for one prompt-admission intent.
     *
     * Repeating the same intent returns its existing run. The unique index below
     * prevents one intent from creating multiple durable executions.
     */
    sessionIntentId: text("session_intent_id").notNull(),
    /**
     * Immutable execution snapshot parsed from the canonical prompt contract.
     *
     * It freezes the agent, explicit provider/model selection, and prompt parts
     * needed by the future inner engine. Session, intent, and run identities stay
     * in the surrounding orchestration columns rather than this JSON value.
     */
    input: text("input", { mode: "json" }).$type<AgentPromptInput>().notNull(),
    /**
     * Authoritative durable lifecycle state for this run.
     *
     * The lifecycle constraint below couples each state to the only valid queue
     * and timestamp shape instead of allowing partially transitioned rows.
     */
    status: text("status").$type<AgentRunStatus>().notNull().default("queued"),
    /**
     * Zero-based FIFO position within this session's currently queued runs.
     *
     * It is required and unique per session while `queued`, then cleared when
     * the run is claimed so non-queued rows never continue occupying the queue.
     */
    queuePosition: integer("queue_position"),
    /**
     * Unix epoch time in milliseconds when the prompt was durably admitted.
     *
     * This records creation independently of whether the run is still waiting,
     * executing, or terminal.
     */
    createdAt: integer("created_at").notNull(),
    /**
     * Unix epoch time in milliseconds when the queued row was atomically claimed.
     *
     * It is null only while `queued` and required for both running and terminal
     * rows, proving that terminal work passed through the running state.
     */
    startedAt: integer("started_at"),
    /**
     * Unix epoch time in milliseconds when execution reached a terminal state.
     *
     * It remains null for queued and running rows and is required for
     * `completed`, `stop`, and `failed` rows.
     */
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("agent_run_session_intent_idx").on(table.sessionIntentId),
    index("agent_run_session_id_idx").on(table.sessionId, table.id),
    uniqueIndex("agent_run_session_running_idx")
      .on(table.sessionId)
      .where(sql`${table.status} = 'running'`),
    index("agent_run_session_queue_idx")
      .on(table.sessionId, table.queuePosition)
      .where(sql`${table.status} = 'queued'`),
    uniqueIndex("agent_run_session_queue_position_idx")
      .on(table.sessionId, table.queuePosition)
      .where(sql`${table.status} = 'queued'`),
    check(
      "agent_run_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'stop', 'failed')`,
    ),
    check(
      "agent_run_lifecycle_check",
      sql`(
        ${table.status} = 'queued'
        AND ${table.queuePosition} IS NOT NULL
        AND ${table.startedAt} IS NULL
        AND ${table.finishedAt} IS NULL
      ) OR (
        ${table.status} = 'running'
        AND ${table.queuePosition} IS NULL
        AND ${table.startedAt} IS NOT NULL
        AND ${table.finishedAt} IS NULL
      ) OR (
        ${table.status} IN ('completed', 'stop', 'failed')
        AND ${table.queuePosition} IS NULL
        AND ${table.startedAt} IS NOT NULL
        AND ${table.finishedAt} IS NOT NULL
      )`,
    ),
    check(
      "agent_run_input_check",
      sql`json_valid(${table.input})
        AND json_type(${table.input}) = 'object'
        AND NULLIF(json_extract(${table.input}, '$.agent'), '') IS NOT NULL
        AND NULLIF(
          json_extract(${table.input}, '$.model.providerID'),
          ''
        ) IS NOT NULL
        AND NULLIF(
          json_extract(${table.input}, '$.model.modelID'),
          ''
        ) IS NOT NULL
        AND json_type(${table.input}, '$.parts') = 'array'
        AND json_array_length(${table.input}, '$.parts') > 0`,
    ),
  ],
);
