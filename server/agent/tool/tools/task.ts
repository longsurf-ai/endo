// Purpose: Delegates a foreground task to a named Agent profile through the existing child executor.

import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Tool } from "@openchart/server/agent/tool/tool";
import { Workflow } from "@openchart/server/agent/workflow";
import { Effect, Schema } from "effect";
import { TaskAgentNotFound } from "./errors";

const nonblank = Schema.String.check(Schema.isPattern(/\S/));

/** A task selects a registered profile and supplies its complete, independent instruction. */
export const Parameters = Schema.Struct({
  agent: nonblank.annotate({
    description: "The registered Agent profile name to call.",
  }),
  description: nonblank.annotate({
    description: "A short title for this task.",
  }),
  prompt: nonblank.annotate({
    description:
      "The complete task and context for the child agent. Parent conversation history is not copied.",
  }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/**
 * Runs a fresh child Session and waits for its answer and cleanup. The caller
 * authorizes delegation; child tools retain their own profile's permissions.
 * Processor commits the child link before execution and owns the tool outcome.
 * Setup lists visible profiles in the description without filtering caller permissions.
 * @example
 * const task = yield* Tool.init(yield* TaskTool);
 * yield* task.execute({agent: 'analyst', description: 'Research', prompt: 'Research AAPL.'}, context);
 */
export const TaskTool = Tool.define(
  "task",
  Effect.gen(function* () {
    const profiles = yield* AgentProfile.Service;
    const agentList = (yield* profiles.all())
      .filter((profile) => !profile.hidden)
      .map(
        (profile) =>
          `- ${profile.name}${profile.description ? `: ${profile.description}` : ""}`,
      )
      .join("\n");
    return {
      description: `Delegate a task to a registered Agent profile. Each call creates a fresh child conversation, waits for completion, and returns its final answer. Include all necessary context in prompt. Independent tasks may be called in parallel. This tool does not resume previous tasks or run in the background.\n\nAvailable agents:\n${agentList}`,
      parameters: Parameters,
      execute: Effect.fn("TaskTool.execute")(function* (
        input: typeof Parameters.Type,
        ctx: Tool.Context,
      ) {
        const profiles = yield* AgentProfile.Service;
        const profile = yield* profiles.resolve(input.agent);
        if (!profile)
          return yield* new TaskAgentNotFound({ agent: input.agent });
        yield* ctx.ask({
          permission: "task",
          patterns: [profile.name],
          always: [profile.name],
          metadata: { agent: profile.name, description: input.description },
        });
        const host = yield* Workflow.Service;
        const model = profile.model
          ? { ...profile.model, selectedVariant: profile.selectedVariant }
          : {
              ...host.parentPrompt.model,
              selectedVariant:
                profile.selectedVariant ??
                host.parentPrompt.model.selectedVariant,
            };
        const result = yield* host.agent(
          {
            agent: profile.name,
            model,
            parts: [{ type: "text", text: input.prompt }],
          },
          (childSessionId) =>
            ctx.metadata({
              title: input.description,
              childSessionIds: [childSessionId],
            }),
          { title: input.description },
        );
        return {
          title: input.description,
          metadata: {},
          output: { type: "text" as const, value: result.output },
        };
      }),
    };
  }),
);
