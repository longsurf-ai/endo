// Purpose: Applies the 20261014191717_initial forward-only SQLite migration.

import { Effect } from "effect";
import type { DatabaseMigration } from "../migration";

const migration: DatabaseMigration.Migration = {
  id: "20261014191717_initial",
  /**
   * Applies this migration inside the runner-owned transaction.
   *
   * @example
   * ```ts
   * yield* migration.up(transaction);
   * ```
   */
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_permission_grants\` (
          \`id\` text PRIMARY KEY,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_messages\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`data\` text NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          CONSTRAINT \`fk_agent_messages_session_id_agent_sessions_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`agent_sessions\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "chk_agent_messages_role" CHECK("role" IN ('user', 'assistant')),
          CONSTRAINT "chk_agent_messages_data_columns" CHECK(
              json_valid("data") AND json_type("data") = 'object'
              AND json_type("data", '$.id') IS NULL
              AND json_type("data", '$.sessionID') IS NULL
              AND json_type("data", '$.role') IS NULL
            )
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_parts\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          CONSTRAINT \`fk_agent_parts_message_id_agent_messages_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`agent_messages\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "chk_agent_parts_data_columns" CHECK(
              json_valid("data") AND json_type("data") = 'object'
              AND json_type("data", '$.id') IS NULL
              AND json_type("data", '$.messageID') IS NULL
              AND json_type("data", '$.sessionID') IS NULL
            )
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_permissions\` (
          \`user_id\` text PRIMARY KEY,
          \`data\` text NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_run\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`session_intent_id\` text NOT NULL,
          \`input\` text NOT NULL,
          \`status\` text DEFAULT 'queued' NOT NULL,
          \`queue_position\` integer,
          \`created_at\` integer NOT NULL,
          \`started_at\` integer,
          \`finished_at\` integer,
          CONSTRAINT \`fk_agent_run_session_id_agent_sessions_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`agent_sessions\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT "agent_run_status_check" CHECK("status" IN ('queued', 'running', 'completed', 'stop', 'failed')),
          CONSTRAINT "agent_run_lifecycle_check" CHECK((
                "status" = 'queued'
                AND "queue_position" IS NOT NULL
                AND "started_at" IS NULL
                AND "finished_at" IS NULL
              ) OR (
                "status" = 'running'
                AND "queue_position" IS NULL
                AND "started_at" IS NOT NULL
                AND "finished_at" IS NULL
              ) OR (
                "status" IN ('completed', 'stop', 'failed')
                AND "queue_position" IS NULL
                AND "started_at" IS NOT NULL
                AND "finished_at" IS NOT NULL
              )),
          CONSTRAINT "agent_run_input_check" CHECK(json_valid("input")
                AND json_type("input") = 'object'
                AND NULLIF(json_extract("input", '$.agent'), '') IS NOT NULL
                AND NULLIF(
                  json_extract("input", '$.model.providerID'),
                  ''
                ) IS NOT NULL
                AND NULLIF(
                  json_extract("input", '$.model.modelID'),
                  ''
                ) IS NOT NULL
                AND json_type("input", '$.parts') = 'array'
                AND json_array_length("input", '$.parts') > 0)
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_session_bindings\` (
          \`id\` text PRIMARY KEY,
          \`key\` text NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          CONSTRAINT "chk_agent_session_bindings_key" CHECK(trim("key") <> '')
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_sessions\` (
          \`id\` text PRIMARY KEY,
          \`parent_id\` text,
          \`kind\` text NOT NULL,
          \`binding_id\` text,
          \`anchors\` text,
          \`title\` text NOT NULL,
          \`compacting_at\` integer,
          \`archived_at\` integer,
          \`last_read_run_id\` text,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          CONSTRAINT \`fk_agent_sessions_binding_id_agent_session_bindings_id_fk\` FOREIGN KEY (\`binding_id\`) REFERENCES \`agent_session_bindings\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_agent_sessions_last_read_run_id_agent_run_id_fk\` FOREIGN KEY (\`last_read_run_id\`) REFERENCES \`agent_run\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT "agent_sessions_kind_check" CHECK("kind" in ('chat', 'delegate', 'dig_in', 'scheduled'))
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_todos\` (
          \`id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          CONSTRAINT \`agent_todos_pk\` PRIMARY KEY(\`session_id\`, \`id\`),
          CONSTRAINT \`fk_agent_todos_session_id_agent_sessions_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`agent_sessions\`(\`id\`) ON DELETE CASCADE
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_schedule_occurrence\` (
          \`id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`schedule_id\` text NOT NULL,
          \`agent_run_id\` text,
          \`fire_at\` integer NOT NULL,
          CONSTRAINT \`fk_agent_schedule_occurrence_schedule_id_agent_schedule_id_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`agent_schedule\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_agent_schedule_occurrence_agent_run_id_agent_run_id_fk\` FOREIGN KEY (\`agent_run_id\`) REFERENCES \`agent_run\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT "agent_schedule_occurrence_id_check" CHECK("id" IS NOT NULL),
          CONSTRAINT "agent_schedule_occurrence_revision_check" CHECK("revision" >= 1),
          CONSTRAINT "agent_schedule_occurrence_created_at_check" CHECK("created_at" >= 0),
          CONSTRAINT "agent_schedule_occurrence_updated_at_check" CHECK("updated_at" >= 0)
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`agent_schedule\` (
          \`id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`name\` text NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`target_json\` text NOT NULL,
          \`recurrence\` text NOT NULL,
          \`next_fire_at\` integer NOT NULL,
          CONSTRAINT "agent_schedule_id_check" CHECK("id" IS NOT NULL),
          CONSTRAINT "agent_schedule_revision_check" CHECK("revision" >= 1),
          CONSTRAINT "agent_schedule_created_at_check" CHECK("created_at" >= 0),
          CONSTRAINT "agent_schedule_updated_at_check" CHECK("updated_at" >= 0),
          CONSTRAINT "chk_agent_schedules_name" CHECK(length(trim("name")) BETWEEN 1 AND 160),
          CONSTRAINT "chk_agent_schedules_target_object" CHECK(json_type("target_json") = 'object'),
          CONSTRAINT "chk_agent_schedules_target" CHECK(CASE json_extract("target_json", '$.kind')
              WHEN 'agent_prompt' THEN COALESCE(
                json_type("target_json", '$.prompt.model') = 'object'
                AND json_type("target_json", '$.prompt.model.providerID') = 'text'
                AND length(json_extract("target_json", '$.prompt.model.providerID')) > 0
                AND json_extract("target_json", '$.prompt.model.providerID') <> 'unknown'
                AND json_type("target_json", '$.prompt.model.modelID') = 'text'
                AND length(json_extract("target_json", '$.prompt.model.modelID')) > 0
                AND json_extract("target_json", '$.prompt.model.modelID') <> 'unknown'
                AND (
                  json_type("target_json", '$.prompt.model.selectedVariant') IS NULL
                  OR (
                    json_type("target_json", '$.prompt.model.selectedVariant') = 'text'
                    AND length(json_extract("target_json", '$.prompt.model.selectedVariant')) > 0
                  )
                )
                AND json(json_remove(
                  json_extract("target_json", '$.prompt.model'),
                  '$.providerID',
                  '$.modelID',
                  '$.selectedVariant'
                )) = '{}',
                0
              )
              ELSE 0
              END),
          CONSTRAINT "chk_agent_schedules_recurrence_shape" CHECK(COALESCE(
                (
                  json_extract("recurrence", '$.kind') = 'cron'
                  AND length(
                      trim(json_extract("recurrence", '$.expression'))
                    ) > 0
                  AND length(
                      trim(json_extract("recurrence", '$.timeZone'))
                    ) > 0
                ) OR (
                  json_extract("recurrence", '$.kind') = 'once'
                  AND json_type("recurrence", '$.fireAt') = 'text'
                  AND length(
                      trim(json_extract("recurrence", '$.fireAt'))
                    ) > 0
                ),
                0
              ))
        );
      `);
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`created_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`updated_at\` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
          \`root\` text NOT NULL UNIQUE,
          CONSTRAINT "workspace_id_check" CHECK("id" IS NOT NULL),
          CONSTRAINT "workspace_revision_check" CHECK("revision" >= 1),
          CONSTRAINT "workspace_created_at_check" CHECK("created_at" >= 0),
          CONSTRAINT "workspace_updated_at_check" CHECK("updated_at" >= 0),
          CONSTRAINT "workspace_root_check" CHECK(length("root") > 0)
        );
      `);
      yield* tx.run(
        "CREATE UNIQUE INDEX `uniq_agent_permission_grants_action_resource` ON `agent_permission_grants` (`action`,`resource`);",
      );
      yield* tx.run(
        "CREATE INDEX `idx_agent_messages_session_created` ON `agent_messages` (`session_id`,`created_at`);",
      );
      yield* tx.run(
        "CREATE INDEX `idx_agent_messages_session_canonical_id` ON `agent_messages` (`session_id`,`id`);",
      );
      yield* tx.run(
        "CREATE INDEX `idx_agent_parts_message` ON `agent_parts` (`message_id`);",
      );
      yield* tx.run(
        "CREATE UNIQUE INDEX `agent_run_session_intent_idx` ON `agent_run` (`session_intent_id`);",
      );
      yield* tx.run(
        "CREATE INDEX `agent_run_session_id_idx` ON `agent_run` (`session_id`,`id`);",
      );
      yield* tx.run(
        'CREATE UNIQUE INDEX `agent_run_session_running_idx` ON `agent_run` (`session_id`) WHERE "agent_run"."status" = \'running\';',
      );
      yield* tx.run(
        'CREATE INDEX `agent_run_session_queue_idx` ON `agent_run` (`session_id`,`queue_position`) WHERE "agent_run"."status" = \'queued\';',
      );
      yield* tx.run(
        'CREATE UNIQUE INDEX `agent_run_session_queue_position_idx` ON `agent_run` (`session_id`,`queue_position`) WHERE "agent_run"."status" = \'queued\';',
      );
      yield* tx.run(
        "CREATE UNIQUE INDEX `uniq_agent_session_bindings_key` ON `agent_session_bindings` (`key`);",
      );
      yield* tx.run(
        "CREATE INDEX `idx_agent_sessions_updated` ON `agent_sessions` (`updated_at`);",
      );
      yield* tx.run(
        "CREATE INDEX `idx_agent_sessions_parent` ON `agent_sessions` (`parent_id`);",
      );
      yield* tx.run(
        "CREATE INDEX `idx_agent_sessions_binding` ON `agent_sessions` (`binding_id`,`created_at`,`id`);",
      );
      yield* tx.run(
        "CREATE UNIQUE INDEX `uniq_agent_todos_position` ON `agent_todos` (`session_id`,`position`);",
      );
      yield* tx.run(
        "CREATE UNIQUE INDEX `uq_agent_schedule_occurrences_slot` ON `agent_schedule_occurrence` (`schedule_id`,`fire_at`);",
      );
      yield* tx.run(
        "CREATE UNIQUE INDEX `uq_agent_schedule_occurrences_run` ON `agent_schedule_occurrence` (`agent_run_id`);",
      );
      yield* tx.run(
        'CREATE INDEX `idx_agent_schedules_due` ON `agent_schedule` (`next_fire_at`,`id`) WHERE "agent_schedule"."enabled" = 1;',
      );
      yield* tx.run(
        'CREATE INDEX `idx_agent_schedules_updated` ON `agent_schedule` ("updated_at" desc);',
      );
    });
  },
};

export default migration;
