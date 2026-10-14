// Purpose: Executes workflow files through the ordinary tool contract.

import { loadWorkflow } from "@openchart/server/agent/workflow/load";
import { Tool } from "@openchart/server/agent/tool/tool";
import { Invocation, run } from "@openchart/server/agent/workflow/runtime";
import { Effect } from "effect";

/**
 * Shares one workflow executor between persisted intent and model-selected calls.
 * @example
 * const tool = yield* Tool.init(yield* WorkflowTool);
 */
export const WorkflowTool = Tool.define(
  "workflow",
  Effect.succeed({
    description:
      "Run a trusted TypeScript workflow file. Use workspace:relative/path.workflow.ts for the current workspace, or default:relative/path.workflow.ts for the default workspace. Shipped workflows live in the default workspace's workflows/ directory. The source location does not change the child agents' workspace. Read the file to understand its description and args schema, then supply the business arguments in args. Files default-export defineWorkflow from @openchart/workflow.",
    parameters: Invocation,
    execute: Effect.fn("WorkflowTool.execute")(function* (
      input: typeof Invocation.Type,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: "workflow",
        patterns: [input.workflow],
        always: [input.workflow],
        metadata: { workflow: input.workflow },
      });
      const { definition, metadata } = yield* loadWorkflow(input.workflow);
      // The same registration feeds durable links and the model-facing index.
      // Collect per invocation so repeated turns deduplicate without leaking siblings.
      const childSessionIds = new Set<string>();
      const result = yield* run(
        definition,
        input.args,
        (preparedArgs) =>
          ctx.metadata({
            title: `Workflow · ${input.workflow}`,
            metadata: { workflow: input.workflow, ...metadata, preparedArgs },
          }),
        (trace) => ctx.metadata({ metadata: { trace } }),
        (childSessionId) =>
          ctx
            .metadata({ childSessionIds: [childSessionId] })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => childSessionIds.add(childSessionId)),
              ),
            ),
      );
      return {
        title: `Workflow · ${input.workflow}`,
        metadata: { workflow: input.workflow, ...metadata },
        output: {
          type: "json" as const,
          value: {
            workflow: input.workflow,
            status: "completed",
            result,
            childSessionIds: [...childSessionIds],
            instruction:
              "This workflow invocation is complete. Use the returned result to answer the user. If the user directly requested this workflow, present its substantive findings, using its final summary when available; a completion acknowledgement alone is insufficient. Address any remaining user instructions. If a result is ambiguous or needs verification, read the relevant child session with read_transcript using a childSessionIds entry as session_id and cursor: null. These references include all direct agent sessions used by this invocation, including continued sessions and handled failures. Do not repeat the invocation.",
          },
        },
      };
    }),
  }),
);
