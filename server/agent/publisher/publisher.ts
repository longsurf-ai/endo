import type { Request as QuestionRequest } from "@openchart/server/agent/question/types";
// Purpose: Defines the protocol-independent change publication boundary for authoritative Agent changes.

export * as Publisher from "./publisher";

import type {
  Assistant,
  MessageInfo,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import type {
  Part,
  StepFinishPart,
} from "@openchart/server/agent/contracts/part";
import type { Session } from "@openchart/server/agent/contracts/session";
import type { Request } from "@openchart/server/agent/permission/types";
import type { AgentRun } from "@openchart/server/agent/run/run";
import { Context, type Effect } from "effect";

/** Authoritative changes, with no client-protocol events or persistence of their own. */
export type Change =
  | { readonly type: "session.updated"; readonly session: Session }
  /** Historical content changed; observers must replace their complete transcript. */
  | { readonly type: "transcript.updated"; readonly sessionID: string }
  | { readonly type: "message.created"; readonly message: WithParts }
  | {
      readonly type: "message.updated";
      readonly message: MessageInfo;
      readonly previous: MessageInfo;
    }
  | {
      readonly type: "part.updated";
      readonly info: MessageInfo;
      readonly part: Part;
      readonly previous?: Part;
    }
  | {
      readonly type: "step.finished";
      readonly message: Assistant;
      readonly part: StepFinishPart;
    }
  | {
      readonly type: "run.updated";
      readonly operation: "enqueue" | "claim" | "complete" | "stop" | "fail";
      readonly run: AgentRun;
      readonly runs: readonly AgentRun[];
    }
  | {
      readonly type: "permissions.updated";
      /** Receiving Session's complete approval view; requests retain their owners. */
      readonly sessionID: string;
      readonly permissions: readonly Request[];
    }
  | {
      readonly type: "questions.updated";
      readonly sessionID: string;
      readonly questions: readonly QuestionRequest[];
    };

/** Application composition supplies one delivery implementation. */
export interface Interface {
  /**
   * Delivers a change before the caller releases its publication barrier.
   * Persisted changes must commit first; failed writes must never publish.
   * Inputs are shared references. Implementations must not mutate them and
   * must copy any data they retain or queue beyond delivery.
   * Implementations may read canonical state, but never acquire the barrier again
   * or wait for a client, model, or permission response.
   * @example
   * yield* publisher.publish({type: 'session.updated', session});
   */
  readonly publish: (change: Change) => Effect.Effect<void>;
}

/** Required change publisher implementation; domain owners never select a protocol. */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Publisher",
) {}
