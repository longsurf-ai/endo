import { Request as QuestionRequest } from "@openchart/server/agent/question/types";
// Purpose: Projects application session state without duplicating persisted prompt input.

import { Session } from "@openchart/server/agent/contracts/session";
import { Request } from "@openchart/server/agent/permission/types";
import { AgentRun } from "@openchart/server/agent/run/run";
import { Schema, Struct } from "effect";

/** Directory facts with activity derived from queued or running Runs. */
export const SessionListItem = Schema.Struct({
  ...Session.fields,
  isActive: Schema.Boolean,
  isUnread: Schema.Boolean,
});

/** Run identity and lifecycle facts; transcript content has one wire representation. */
export const RunState = AgentRun.mapFields(Struct.omit(["input"]));

// Permission already validated its JSON at the domain boundary. On the wire,
// metadata is opaque so tRPC clients do not recursively instantiate JSON values.
const PermissionState = Request.mapFields((fields) => ({
  ...fields,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}));

/** Public Session facts derived from their owners, independent of client protocol. */
export const SessionState = Schema.Struct({
  session: Session,
  runs: Schema.Array(RunState),
  // This Session's own and delegated descendants' requests; each retains its owner.
  permissions: Schema.Array(PermissionState),
  questions: Schema.Array(QuestionRequest),
});

/**
 * Returns admission and lifecycle facts without echoing the submitted prompt.
 * @example
 * const receipt = projectRun(yield* submitPrompt(request));
 */
export function projectRun(run: AgentRun) {
  return Struct.omit(run, ["input"]);
}

/**
 * Removes stored submission payloads from reactive run state.
 * @example
 * const state = {runs: projectRuns(yield* runs.list(sessionID))};
 */
export function projectRuns(runs: readonly AgentRun[]) {
  return runs.map(projectRun);
}
