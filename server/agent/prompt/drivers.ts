// Purpose: Creates the workflow and plugin services for one prompt invocation.

import { Plugin } from "@openchart/server/agent/plugin";
import { Workflow } from "@openchart/server/agent/workflow";
import { makeWorkflowHost } from "@openchart/server/agent/workflow/host";
import { Context, Effect } from "effect";
import type { Invocation, PreparedInvocation } from "./execute";

/**
 * Creates fresh services after the trigger User commits. The invocation's Scope
 * owns plugin cleanup through preparation, title generation, and the Agent loop.
 * Child prompts use the supplied executor to create their own services.
 * @example
 * const drivers = yield* createDrivers(invocation, input, executeInvocation);
 * yield* execution.pipe(Effect.provideContext(drivers));
 */
export const createDrivers = <E, R>(
  invocationContext: Invocation,
  input: PreparedInvocation,
  execute: (invocation: Invocation) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const workflowHost = yield* makeWorkflowHost(invocationContext, execute, {
      concurrency: 5,
    });
    const pluginHost = yield* Plugin.create(input.definitions, {
      runID: invocationContext.rootRunID,
      sessionID: input.session.id,
      triggerMessageID: input.user.id,
      agent: input.profile.name,
      pluginInputs: input.pluginInputs,
      model: input.user.model,
    });

    return Context.make(Workflow.Service, workflowHost).pipe(
      Context.add(Plugin.Service, pluginHost),
    );
  });
