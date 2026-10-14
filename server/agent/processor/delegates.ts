// Purpose: Routes provider delegate events to their persisted Assistant and step lifecycle.

import type {
  Assistant,
  User,
} from "@openchart/server/agent/contracts/message";
import { ascending } from "@openchart/identifier";
import type { ProviderDelegateCall } from "@openchart/models/provider-protocol";
import type { Session } from "@openchart/server/agent/session/session";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Clock, Effect } from "effect";

/** The sole mutable lifecycle record for one projected Assistant. */
export interface Destination {
  message: Assistant;
  step: "pending" | "active" | "finished";
}

/**
 * Creates the processor's delegate routing table without starting any request.
 * Processor advances each Destination only after its matching write commits.
 * Root may start another step; every child has exactly one step.
 *
 * ```text
 * call A, openDelegate                   -> root proxy A -> child A
 * delegateCallId A                       -> child A content / step
 * call B, openDelegate, delegateCallId A -> child A proxy B -> child B
 * delegateCallId B                       -> child B content / step
 * finish child B -> result B with delegateCallId A closes only its proxy
 * finish child A -> root result A closes only its proxy
 * ```
 *
 * A proxy never supplies its child's answer or completion. The provider's
 * scoped finish-step is the sole child completion event; abrupt exits leave
 * unfinished Destinations for the processor's terminal cleanup.
 * @example
 * const delegates = createDelegates(assistant, session);
 * const destination = delegates.route(event.providerMetadata?.openchart?.delegateCallId);
 */
export function createDelegates(
  assistant: Assistant,
  session: Session.Interface,
) {
  const root: Destination = { message: assistant, step: "pending" };
  const children = new Map<string, Destination>();

  const route = (delegateCallId: string | undefined): Destination => {
    if (delegateCallId === undefined) return root;
    const destination = children.get(delegateCallId);
    assertExists(
      destination,
      `Provider event references unknown delegate ${delegateCallId}`,
    );
    return destination;
  };

  const start = Effect.fn("Processor.startDelegate")(function* (
    callID: string,
    parent: Destination,
    call: ProviderDelegateCall,
  ) {
    // Processor serializes creation after checking the active step and new call.
    const trigger = yield* session.getMessage({
      sessionID: parent.message.sessionID,
      messageID: parent.message.triggeringUserMessageID,
    });
    assertExists(trigger, "A delegate requires its parent's trigger message");
    assertTrue(
      trigger.info.role === "user",
      "A delegate requires a trigger User",
    );
    const child = yield* session.create({
      parentId: parent.message.sessionID,
      kind: "delegate",
      title: `${call.description} (@${call.agent} subagent)`,
    });
    const now = yield* Clock.currentTimeMillis;
    const user: User = {
      id: `msg_${ascending()}`,
      sessionID: child.id,
      role: "user",
      time: { created: now },
      agent: assistant.agent,
      workspaceId: trigger.info.workspaceId,
      model: { providerID: assistant.providerID, modelID: assistant.modelID },
    };
    yield* session.createMessage({
      info: user,
      parts: [
        {
          id: `prt_${ascending()}`,
          messageID: user.id,
          type: "text",
          text: call.prompt,
        },
      ],
    });
    const message: Assistant = {
      id: `msg_${ascending()}`,
      sessionID: child.id,
      role: "assistant",
      triggeringUserMessageID: user.id,
      providerID: assistant.providerID,
      modelID: assistant.modelID,
      agent: assistant.agent,
      path: { ...assistant.path },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: now },
    };
    yield* session.createMessage({ info: message, parts: [] });
    // The caller serializes this whole transition. Register immediately after
    // creation so a later proxy write failure still finalizes this Assistant.
    children.set(callID, { message, step: "pending" });
    return child.id;
  });

  return {
    root,
    all: (): Iterable<Destination> => [root, ...children.values()],
    route,
    start,
    assertProxyFinished: (callID: string): void => {
      const child = children.get(callID);
      if (!child) return;
      assertTrue(
        child.step === "finished",
        `Delegate ${callID} proxy finished before its child finish-step`,
      );
    },
  };
}
