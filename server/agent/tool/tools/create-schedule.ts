// Purpose: Creates recurring agent schedules through the existing Schedule Resource.

import { Tool } from "@openchart/server/agent/tool/tool";
import { Workflow } from "@openchart/server/agent/workflow";
import { Transactor } from "@openchart/server/lib/resource";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { AgentScheduleCronRecurrence } from "@openchart/server/resources/agent-schedule/schema";
import { Effect, Schema } from "effect";
import { ask, parse, result } from "./resource-shared";

const Parameters = Schema.Struct({
  name: agentScheduleResource.entity.fields.name,
  prompt: Schema.String.check(Schema.isPattern(/\S/)).annotate({
    description:
      "The complete instruction to run each time. Include all necessary context; conversation history is not copied.",
  }),
  recurrence: AgentScheduleCronRecurrence,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/**
 * Creates an enabled cron schedule using the current invocation's agent, model,
 * and workspace. Permission precedes the existing Resource transaction; its
 * owner validates persistence and calculates the next fire without running it.
 * @example
 * const tool = yield* Tool.init(yield* CreateScheduleTool);
 * yield* tool.execute({name: 'Morning review', prompt: 'Review the market.', recurrence: {kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'America/Los_Angeles'}}, context);
 */
export const CreateScheduleTool = Tool.define(
  "create_schedule",
  Effect.succeed({
    description:
      "Create an enabled recurring schedule for an agent prompt. Supply a name, a self-contained prompt, and a recurrence with kind cron, a five-field cron expression, and an IANA timeZone. Reuses the current agent, model, and workspace. Each fire starts a fresh conversation. Returns the saved schedule including its id and nextFireAt. No Resource schema lookup is needed.",
    parameters: Parameters,
    execute: (input: typeof Parameters.Type, context: Tool.Context) =>
      result(
        "Create schedule",
        Effect.gen(function* () {
          const { parentPrompt } = yield* Workflow.Service;
          const body = yield* parse(agentScheduleResource.createSchema, {
            name: input.name,
            recurrence: input.recurrence,
            target: {
              kind: "agent_prompt",
              prompt: {
                agent: parentPrompt.agent,
                model: parentPrompt.model,
                workspaceId: parentPrompt.workspaceId,
                parts: [{ type: "text", text: input.prompt }],
              },
            },
          });
          yield* ask(context, "create_schedule", ["agent_schedule"], input);
          const entity = yield* Transactor.run(
            agentScheduleResource.transitions.create(body),
          );
          return { resource: agentScheduleResource.name, entity };
        }),
      ),
  }),
);
