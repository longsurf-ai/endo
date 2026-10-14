// Purpose: Composes claimed prompt preparation, deterministic actions, and model steps.

import {
  SessionId,
  type Session as SessionInfo,
} from "@openchart/server/agent/contracts/session";
import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import type {
  Assistant,
  User,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import { ascending } from "@openchart/identifier";
import type { AvailableModel } from "@openchart/models/model-provider";
import type { Workflow } from "@openchart/server/agent/workflow";
import { immutable } from "@openchart/server/agent/workflow/authoring/shared/immutable";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Plugin } from "@openchart/server/agent/plugin";
import { PluginRegistry } from "@openchart/server/agent/plugin/registry";
import type { AgentRun } from "@openchart/server/agent/run/run";
import { Session } from "@openchart/server/agent/session/session";
import { Models } from "@openchart/server/models";
import { Transactor } from "@openchart/server/lib/resource";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { WorkspaceId } from "@openchart/server/resources/workspace/entity";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Effect, type Schema, type Scope } from "effect";
import {
  executeDeterministicAction,
  nextDeterministicAction,
} from "./deterministic-action";
import { createDrivers } from "./drivers";
import { ProfileNotFound } from "./errors";
import {
  derivePromptLoopAnchors,
  isNaturalReplyForUser,
  readHistory,
} from "./history";
import { createUser } from "./input";
import { processStep } from "./step";
import { ensure as ensureTitle } from "./title";

/**
 * Handles one claimed intent, with title generation and the loop sharing a scope.
 * Runner retains Run outcomes; failure or interruption waits for sibling cleanup.
 * @example
 * yield* execute(claimedRun);
 */
export const execute = Effect.fn("Prompt.execute")(function* (run: AgentRun) {
  assertTrue(run.status === "running", "Prompt requires a claimed running Run");
  yield* executeInvocation({
    rootRunID: run.id,
    sessionID: run.sessionID,
    input: run.input,
  });
});

/** Target session and accepted input are independent of the root queue row. */
export interface Invocation {
  readonly rootRunID: string;
  readonly sessionID: string;
  readonly input: AgentPromptInput;
  /** Optional final-answer constraint for this invocation, never inherited by children. */
  readonly outputSchema?: Schema.JsonObject;
}

/** Resolved invocation input with its trigger User already committed. */
export type PreparedInvocation = Effect.Success<
  ReturnType<typeof prepareInvocation>
>;

type InvocationServices = Exclude<
  Effect.Services<
    | ReturnType<typeof prepareInvocation>
    | ReturnType<typeof Plugin.create>
    | ReturnType<typeof prepareTurn>
    | ReturnType<typeof loop>
  >,
  Plugin.Service | Workflow.Service | Scope.Scope
>;

/**
 * Executes a fresh prompt in a session under an existing root Run. Child calls
 * reuse this engine and inherit the calling fiber's cancellation and cleanup.
 * Only Runner calls the claimed-run adapter; inline children never enqueue Runs.
 * @example
 * yield* executeInvocation({rootRunID, sessionID: child.id, input: childPrompt});
 */
export const executeInvocation = (
  invocation: Invocation,
): Effect.Effect<void, unknown, InvocationServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const invocationContext = immutable(invocation);
      const input = yield* prepareInvocation(invocationContext);

      yield* Effect.gen(function* () {
        const preparedTurn = yield* prepareTurn(input);
        yield* Effect.all([ensureTitle(preparedTurn), loop(preparedTurn)], {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(
        Effect.provideContext(
          yield* createDrivers(invocationContext, input, executeInvocation),
        ),
      );
    }),
  );

/** Initial turn snapshot; title generation retains this oldest-first history. */
export interface PreparedTurn {
  readonly rootRunID: string;
  readonly outputSchema?: Schema.JsonObject;
  /** Canonical workspace root resolved once for this invocation. */
  readonly cwd: string;
  readonly session: SessionInfo;
  readonly model: AvailableModel;
  readonly messages: WithParts[];
  readonly profile: AgentProfile.Info;
}

/**
 * One unfinished loop iteration, rebuilt from committed history before each action.
 * Helpers derive their inputs from this snapshot; preparation is never reused here.
 */
export interface TurnStep {
  readonly rootRunID: string;
  readonly outputSchema?: Schema.JsonObject;
  readonly cwd: string;
  readonly messages: WithParts[];
  readonly user: User;
  readonly agent: AgentProfile.Info;
  readonly model: AvailableModel;
  readonly lastFinished: Assistant | undefined;
  readonly step: number;
}

const prepareInvocation = Effect.fn("Prompt.prepareInvocation")(function* (
  invocationContext: Invocation,
) {
  const sessions = yield* Session.Service;
  const session = yield* sessions.get(
    SessionId.make(invocationContext.sessionID),
  );
  if (!session)
    return yield* new StoreNotFound({
      entity: "session",
      id: invocationContext.sessionID,
    });
  const profiles = yield* AgentProfile.Service;
  const resolved = yield* profiles.resolve(invocationContext.input.agent);
  if (!resolved)
    return yield* new ProfileNotFound({ name: invocationContext.input.agent });
  const profile = structuredClone(resolved);
  const registry = yield* PluginRegistry.Service;
  const definitions = PluginRegistry.resolve(
    yield* registry.all(),
    profile.name,
  );
  const pluginInputs = invocationContext.input.parts.flatMap((part) =>
    part.type === "plugin_input" ? [part.input] : [],
  );
  yield* PluginRegistry.requireInputs(definitions, pluginInputs, profile.name);
  const cwd = yield* readWorkspaceRoot(invocationContext.input.workspaceId);
  const user = yield* createUser(session, invocationContext.input, profile);
  return {
    session,
    profile,
    user,
    definitions,
    pluginInputs,
    cwd,
    rootRunID: invocationContext.rootRunID,
    outputSchema: invocationContext.outputSchema,
  };
});

/** Reads the registered root, selecting the default workspace when omitted. */
const readWorkspaceRoot = Effect.fn("Prompt.readWorkspaceRoot")(function* (
  workspaceId: AgentPromptInput["workspaceId"],
) {
  const id = workspaceId
    ? WorkspaceId.make(workspaceId)
    : yield* Transactor.run(workspaceResource.transitions.getDefault());
  const { root } = yield* Transactor.run(workspaceResource.transitions.get(id));
  return root;
});

const prepareTurn = Effect.fn("Prompt.prepareTurn")(function* (
  input: PreparedInvocation,
) {
  const sessions = yield* Session.Service;
  const models = yield* Models.Service;
  const plugins = yield* Plugin.Service;

  const contexts = yield* plugins.trigger("run.before");

  yield* sessions.createParts(
    contexts.map((context) => ({
      id: `prt_${ascending()}`,
      messageID: input.user.id,
      type: "context" as const,
      context,
    })),
  );
  yield* sessions.update(input.session.id, {});
  const model = yield* models.getModel(
    input.user.model.providerID,
    input.user.model.modelID,
  );
  const messages = yield* readHistory(input.session.id);
  return {
    rootRunID: input.rootRunID,
    session: input.session,
    model,
    messages,
    profile: input.profile,
    cwd: input.cwd,
    outputSchema: input.outputSchema,
  };
}, Effect.satisfiesSuccessType<PreparedTurn>());

const prepareStep = Effect.fn("Prompt.prepareStep")(function* (
  invocation: PreparedTurn,
  step: number,
) {
  const messages = yield* readHistory(invocation.session.id);
  const {
    lastUser: user,
    lastAssistant,
    lastFinished,
  } = derivePromptLoopAnchors(messages);
  assertExists(user, "A claimed prompt must have a committed User");
  if (isNaturalReplyForUser(user.id, lastAssistant)) return undefined;

  const agent = invocation.profile;
  const model = invocation.model;
  return {
    rootRunID: invocation.rootRunID,
    cwd: invocation.cwd,
    outputSchema: invocation.outputSchema,
    messages,
    user,
    agent,
    model,
    lastFinished,
    step,
  };
}, Effect.satisfiesSuccessType<TurnStep | undefined>());

const loop = Effect.fn("Prompt.loop")(function* (invocation: PreparedTurn) {
  for (let step = 1; ; step++) {
    const preparedStep = yield* prepareStep(invocation, step);
    if (!preparedStep) break;
    const action = yield* nextDeterministicAction(preparedStep);
    if (action) {
      yield* executeDeterministicAction(preparedStep, action);
      continue;
    }
    yield* processStep(preparedStep);
  }
});
